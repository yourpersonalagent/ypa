#!/usr/bin/env python3
"""
YPA-Kostenmodell  —  Cloud-API (Opus) vs. lokale Hardware vs. gemieteter Server.
Standort Wien, Preisstand siehe PRICES_AS_OF. Reproduzierbar & erweiterbar:
zum Aktualisieren einfach die Konstanten unten + das Datum ändern.

  python tools/ypa_cost.py                  # Standard-Annahmen
  python tools/ypa_cost.py --sessions 40    # 40 Sessions/Monat annehmen

Quellen (Stand 2026-06-03):
  - Opus API:  platform.claude.com/docs/en/about-claude/pricing  ($5 / $25 je Mio Tok)
  - RTX 5090:  geizhals.at  (~€3.790–3.880),  575W TDP / ~1000W PSU
  - Mac Studio M4 Max 128GB/1TB:  geizhals.at  (€4.291)
  - Mac mini M4 Pro 64GB:  apple.com/at  (max. 64GB! 128GB nur Studio/Ultra)
  - Strom Wien:  smartmeter-portal.at  (21–24 ct/kWh brutto Haushalt 2026)
  - Glasfaser Wien:  a1.net  (ab €29,90/Mo nach Aktion)

Hardware-Vergleich (Recherche 2026-06-04, EUR inkl. AT-USt; Q4 Single-Stream):
  - Pi5 16GB ~€145; Mac mini M4 ~€720, M4 Pro 64GB ~€2.870; Mac Studio M4 Max 128GB
    ~€4.291, M3 Ultra 96GB ~€4.790 (256/512GB seit 03/2026 GESTRICHEN, DRAM-Engpass);
    RTX 5090 Tower ~€4.600, 2x ~€6.800. Quellen: geizhals.at/de, apple.com/at,
    llama.cpp/Ollama-Benchmarks. Details + Domains: docs/business-plan/.
"""
from __future__ import annotations
import argparse
import json
import math
import os
import sys
import urllib.request
from dataclasses import dataclass

# Windows-Konsole auf UTF-8 zwingen, damit € korrekt erscheint
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PRICES_AS_OF = "2026-06-03"
USD_PER_EUR = 1.08            # $ je 1 € (zum Umrechnen der USD-API-Preise)

# ── 1. Anthropic API: Claude Opus 4-8 ───────────────────────────────────────
OPUS_IN_USD_PER_MTOK  = 5.00      # $/Mio Input-Token
OPUS_OUT_USD_PER_MTOK = 25.00     # $/Mio Output-Token
CACHE_READ_FACTOR     = 0.10      # Cache-Hit kostet 10 % des Input-Preises
ASSUMED_CACHE_HIT     = 0.85      # Anteil Input-Token, der aus dem Cache kommt

# ── 2. Strom & Internet (Wien) ──────────────────────────────────────────────
EUR_PER_KWH     = 0.25            # all-in Haushalt 2026 (21–24 ct brutto)
INTERNET_EUR_MO = 35.0            # solider Glasfaser-Anschluss

# ── 3. Lokale Hardware (Geizhals/Apple AT, EUR brutto) ──────────────────────
@dataclass
class Box:
    name: str
    price_eur: float
    watts_load: float
    watts_idle: float
    usable_mem_gb: int            # nutzbar für LLM-Gewichte
    note: str
    amort_years: float = 4.0

BOXES = {
    "rtx5090": Box("RTX 5090 Gaming-PC", 3800 + 800, 650, 60, 32,
                   "Top fürs Gaming; lokal nur ~32B-Modelle flott; KEIN Opus.",),
    "studio":  Box("Mac Studio M4 Max 128GB/1TB", 4291, 130, 12, 110,
                   "Leise/sparsam, ~70B-Modelle lokal; KEIN Opus.",),
    "mini":    Box("Mac mini M4 Pro 64GB/1TB", 2100, 80, 8, 56,
                   "Max. 64GB! 128GB gibt's nur als Studio/Ultra.",),
}

# ── 4. Gemietete Server (für Community-Fernzugriff, schnell wechselbar) ──────
VPS_APP_EUR_MO   = 10.0           # leichter App-Host (Hetzner/Contabo), swap-bar
GPU_CLOUD_USD_HR = 0.70           # RunPod RTX-5090-Klasse, on-demand

# ── 5. GPU-Fleet: VRAM-Sizing & geteilte Always-on-Kosten ───────────────────
VRAM_PER_5090_GB     = 32         # RTX 5090 = 32 GB GDDR7
EXTRA_5090_EUR       = 2000       # je weitere 5090 im selben Knoten (Karte + Netzteil/Kühlung)
EXTRA_5090_W         = 575        # zusätzliche Last-TDP je weiterer Karte
EXTRA_5090_IDLE_W    = 30         # zusätzlicher Idle-Verbrauch je weiterer Karte
CLOUD_STORAGE_EUR_MO = 12.0       # Objektspeicher: Gewichte-Backup + Session-DB offsite


@dataclass
class ModelTier:
    label: str
    params_b: int
    gb_per_b: float               # VRAM je Mrd. Parameter beim gewählten Quant
    quant: str
    eu_open: str                  # Herkunft / Lizenz-Hinweis

    def weight_gb(self) -> float:
        return self.params_b * self.gb_per_b

    def gpus(self, kv_factor: float = 1.35) -> int:
        # +35 % für KV-Cache/Kontext/Overhead, dann auf 32-GB-Karten aufrunden
        return max(1, math.ceil(self.weight_gb() * kv_factor / VRAM_PER_5090_GB))


# gb_per_b: Q4≈0.6, Q8≈1.1 (inkl. etwas Overhead). MoE: VRAM ~ Gesamt-, Tempo ~ aktive Params.
MODEL_TIERS = [
    ModelTier("Mistral-Nemo 12B",        12, 0.6, "Q4", "EU (Mistral/FR), Apache-2.0"),
    ModelTier("Hermes/Dolphin 32B",      32, 0.6, "Q4", "uncensored Fine-Tune (Nous/…)"),
    ModelTier("Mixtral 8x7B (MoE ~47B)", 47, 0.6, "Q4", "EU (Mistral/FR), Apache-2.0"),
    ModelTier("Llama/Qwen 70B",          70, 0.6, "Q4", "offen; Fine-Tunes uncensored"),
    ModelTier("Mistral-Large 123B",     123, 0.6, "Q4", "EU (Mistral/FR), offene Gewichte"),
    ModelTier("70B in Q8 (mehr Qualität)",70, 1.1, "Q8", "offen; lange Kontexte/Multi-User"),
]


# ── 7. Public-Produkt: Recht/Steuer (AT) + EU-Infra + Modell-Roster ─────────
# ACHTUNG: Recht/Steuer sind SCHÄTZUNGEN — mit echten Kanzlei-/StB-Zahlen ersetzen
# (CLI: --legal-setup / --legal-yearly). AT-GmbH-Stammkapital ist NICHT enthalten
# (durchlaufender Posten, kein Aufwand) — hier nur Beratung/Gründung/Buchhaltung.
LEGAL_SETUP_EUR     = 3000.0      # einmalig je Jurisdiktion: Anwalt + Notar + Gründung
LEGAL_YEARLY_EUR    = 4000.0      # laufend/Jahr: Steuerberater + Buchhaltung + Beratung
LEGAL_AMORT_YEARS   = 4.0         # Setup über 4 Jahre verteilt (wie Hardware)
EU_DB_HOST_EUR_MO   = 15.0        # gemanagte EU-DB (Postgres o.ä.), zusätzlich zum VPS
DOMAIN_EUR_YEAR     = 117.0       # Domains GEKAUFT 2026-06-04 (Cloudflare): ypa.dev $90 Premium + 3x openypa $12 = $126/J ~= €117
BETA_HOURS_MO       = 40.0        # Beta-Testen: sporadisch, ~ein Wochenende/Monat


@dataclass
class RosterModel:
    tier: ModelTier
    role: str                     # "günstig" / "coding" / "companion"
    beta: bool = True             # +1 Beta-Slot für neue Versionen?


# Das öffentliche YPA-Angebot: offene Gewichte, jeweils Prod + (optional) Beta.
ROSTER = [
    RosterModel(ModelTier("gpt-oss 20B",       20, 0.6, "Q4", "OpenAI, Apache-2.0"),   "günstig"),
    RosterModel(ModelTier("Gemma 3 27B",       27, 0.6, "Q4", "Google, offen"),        "günstig"),
    RosterModel(ModelTier("Qwen2.5-Coder 32B", 32, 0.6, "Q4", "offen (Alibaba)"),      "coding"),
    RosterModel(ModelTier("Codestral 22B",     22, 0.6, "Q4", "EU (Mistral/FR)"),      "coding"),
    RosterModel(ModelTier("Dolphin/Hermes 32B",32, 0.6, "Q4", "uncensored Fine-Tune"), "companion"),
    RosterModel(ModelTier("FLUX.1 (Bild-Gen)",  12, 1.0, "FP8", "EU! Black Forest Labs/DE"), "visual"),
]


# ── Gemessener Ist-Verbrauch aus bridge/data/sessions.db (~11-Tage-Fenster) ──
MEASURED = dict(in_mtok=154.611, out_mtok=3.370, sessions=125, days=11)


def eur(x: float) -> str:
    return f"€{x:,.0f}".replace(",", ".")


def api_cost_eur(in_mtok: float, out_mtok: float, use_cache: bool = True) -> float:
    if use_cache:
        reads = in_mtok * ASSUMED_CACHE_HIT
        fresh = in_mtok * (1 - ASSUMED_CACHE_HIT)
        in_usd = reads * OPUS_IN_USD_PER_MTOK * CACHE_READ_FACTOR \
            + fresh * OPUS_IN_USD_PER_MTOK
    else:
        in_usd = in_mtok * OPUS_IN_USD_PER_MTOK
    out_usd = out_mtok * OPUS_OUT_USD_PER_MTOK
    return (in_usd + out_usd) / USD_PER_EUR


def local_tco_eur_per_year(box: Box, load_hours_per_day: float = 4.0,
                           share_internet: bool = False) -> dict:
    load_wh = box.watts_load * load_hours_per_day
    idle_wh = box.watts_idle * (24 - load_hours_per_day)
    kwh_year = (load_wh + idle_wh) * 365 / 1000
    electricity = kwh_year * EUR_PER_KWH
    amort = box.price_eur / box.amort_years
    internet = INTERNET_EUR_MO * 12 if share_internet else 0.0
    return dict(amort=amort, electricity=electricity, internet=internet,
                total=amort + electricity + internet, kwh_year=kwh_year)


def node_cost_eur_mo(gpus: int, util: float) -> dict:
    """All-in Monatskosten EINES immer-an Knotens (Amortisation + Strom)."""
    box = BOXES["rtx5090"]
    hw = box.price_eur + EXTRA_5090_EUR * (gpus - 1)
    amort = hw / box.amort_years / 12
    load_w = box.watts_load + EXTRA_5090_W * (gpus - 1)
    idle_w = box.watts_idle + EXTRA_5090_IDLE_W * (gpus - 1)
    kwh = (load_w * 24 * util + idle_w * 24 * (1 - util)) * 30 / 1000
    power = kwh * EUR_PER_KWH
    return dict(amort=amort, power=power, kwh=kwh, total=amort + power)


def fleet_cost_mo(total_gpus: int, gpus_per_node: int, util: float) -> dict:
    """Packe N GPUs in Knoten (je gpus_per_node) und summiere die Monatskosten."""
    nodes = max(1, math.ceil(total_gpus / gpus_per_node)) if total_gpus else 0
    per = node_cost_eur_mo(gpus_per_node, util)
    return dict(nodes=nodes, per_node=per["total"], total=per["total"] * nodes)


def beta_ondemand_eur_mo(beta_gpus: int, hours_mo: float) -> float:
    """Beta-Slots sporadisch on-demand mieten statt always-on zu besitzen."""
    return beta_gpus * GPU_CLOUD_USD_HR * hours_mo / USD_PER_EUR


def legal_admin_eur_mo(setup: float, yearly: float, regions: int) -> dict:
    """Recht/Steuer je Jurisdiktion; Setup über LEGAL_AMORT_YEARS verteilt."""
    setup_mo = setup * regions / LEGAL_AMORT_YEARS / 12
    yearly_mo = yearly * regions / 12
    return dict(setup_mo=setup_mo, yearly_mo=yearly_mo, total=setup_mo + yearly_mo)


# ── 9. Hardware-Katalog: heterogene Heim-Knoten (Recherche 2026-06-04) ───────
# Vergleichs-Katalog (separat von BOXES oben, das die 5090-Fleet-Mathematik trägt).
# tok/s = Einzel-Stream-Decode bei Q4; 0 = passt nicht / nicht relevant (Control/Burst).
# owned=True: schon vorhanden (Pi/Laptop/3080) -> in Meilensteinen NUR Strom, keine Amort.
FEELS_REAL_TPS = 15.0          # Schwelle "fühlt sich wie ein echter Assistent an"


@dataclass
class HW:
    key: str
    name: str
    plane: str            # control | inference | burst
    role: str
    price_eur: float
    mem_gb: int
    bw_gbs: int           # Speicher-Bandbreite = #1-Treiber der tok/s
    idle_w: float
    load_w: float
    tps_8b: float
    tps_32b: float
    tps_70b: float
    amort_years: float = 4.0
    note: str = ""
    owned: bool = False

    def best_model(self) -> tuple:
        """(Params B, tok/s) des größten Modells >= FEELS_REAL_TPS, sonst größtes das passt."""
        tiers = ((70, self.tps_70b), (32, self.tps_32b), (8, self.tps_8b))
        for p, t in tiers:
            if t >= FEELS_REAL_TPS:
                return p, t
        for p, t in tiers:
            if t > 0:
                return p, t
        return 0, 0.0

    def capability(self) -> float:
        p, t = self.best_model()
        return p * t          # belohnt Modellgröße UND Tempo

    def tco_year(self, util: float) -> dict:
        amort = self.price_eur / self.amort_years
        kwh = (self.load_w * 24 * util + self.idle_w * 24 * (1 - util)) * 365 / 1000
        power = kwh * EUR_PER_KWH
        return dict(amort=amort, power=power, kwh=kwh, total=amort + power)

    def cost_mo(self, util: float, amort: bool = True) -> float:
        t = self.tco_year(util)
        return (t["total"] if amort else t["power"]) / 12


HARDWARE = [
    HW("pi5",        "Raspberry Pi 5 16GB",      "control",   "Always-on Router/Cron/WoL",
       145,   16,   17,   3,   10,    3,   0,   0, owned=True,
       note="Control-Plane: orchestriert, rechnet nicht (~3 tok/s = Diashow)."),
    HW("laptop",     "Alter Laptop (Standby)",   "control",   "Cold/Warm-Failover",
       200,    8,   50,   8,   45,    6,   0,   0, amort_years=1.0, owned=True,
       note="Notfall-Backup, schon vorhanden (Restwert)."),
    HW("rtx3080",    "RTX 3080 10GB (vorhanden)","burst",     "Bild (Flux) — bursty",
       350,   10,  760,  30,  320,    0,   0,   0, owned=True,
       note="Schon da: Flux 1/2; eine GPU bedient viele, kein warmes LLM."),
    HW("mini_m4",    "Mac mini M4 16GB",         "inference", "Einstieg: 8B-Assistent",
       720,   16,  120,   4,   35,   24,   0,   0,
       note="16GB-Decke -> nur ~8B."),
    HW("mini_m4pro", "Mac mini M4 Pro 64GB",     "inference", "Warmes 24-32B, sparsam",
       2870,  64,  273,   7,   65,   50,  18,   8,
       note="mini-Maximum 64GB; 70B nur zaeh (~8 tok/s)."),
    HW("studio_max", "Mac Studio M4 Max 128GB",  "inference", "70B @ ~20 tok/s, leise",
       4291, 128,  546,  12,  130,   83,  30,  20,
       note="Bestes Apple-P/L fuer 70B (Sweet-Spot)."),
    HW("studio_ult", "Mac Studio M3 Ultra 96GB", "inference", "Schnellste Apple-Bandbreite",
       4790,  96,  819,  18,  180,   92,  38,  28,
       note="819 GB/s; 256/512GB seit 03/2026 gestrichen -> 96GB-Decke."),
    HW("rtx5090",    "RTX 5090 Tower 32GB",      "inference", "<=32B blitzschnell; KEIN 70B",
       4600,  32, 1792,  30,  575,  142,  48,   0,
       note="32GB-Decke; Top fuer 24-32B + Gaming + Bild."),
    HW("rtx5090x2",  "2x RTX 5090 64GB",         "inference", "70B @ 27 tok/s (Tensor-Parallel)",
       6800,  64, 1792,  60, 1150,  142,  48,  27,
       note="64GB schaltet 70B frei; ~1150W Last, laut."),
]
HW_BY_KEY = {h.key: h for h in HARDWARE}


def _plane_util(plane: str, util: float) -> float:
    """Realistische Auslastung je Ebene: Inferenz = util, Burst niedrig, Control quasi-idle."""
    return {"inference": util, "burst": 0.10, "control": 0.30}.get(plane, util)


def cloud_usd_hr_for(hw: HW) -> float:
    """Vergleichbare On-Demand-Cloud-Rate ($/h) je Leistungsklasse der Box."""
    p, t = hw.best_model()
    if p >= 70 and t >= FEELS_REAL_TPS:
        return 1.80               # 70B-faehig: A100/2x5090-Klasse
    if p >= 32 and t >= FEELS_REAL_TPS:
        return GPU_CLOUD_USD_HR    # 0.70, RTX-5090-Klasse
    return 0.40                    # kleine Box


def own_vs_rent_breakeven_h(hw: HW):
    """Nutzungsstunden/Monat, ab denen Eigenbesitz die Cloud-Miete schlaegt (sonst None)."""
    if hw.plane != "inference":
        return None
    amort_mo = hw.price_eur / hw.amort_years / 12
    i = hw.idle_w / 1000 * EUR_PER_KWH           # EUR/h idle
    l = hw.load_w / 1000 * EUR_PER_KWH           # EUR/h Last
    c = cloud_usd_hr_for(hw) / USD_PER_EUR       # EUR/h Cloud
    denom = c - l + i
    if denom <= 0:
        return None                              # Cloud schlaegt Besitz schon beim Strom
    return (amort_mo + 720 * i) / denom


# ── 10. Meilenstein-Leiter: Schritt fuer Schritt hochskalieren ───────────────
@dataclass
class Milestone:
    name: str
    horizon: str
    hw_keys: list
    users: int
    price: float              # EUR/Nutzer/Monat (0 = Eigenbedarf/kostenlos)
    regions: int = 1
    commercial: bool = False  # Recht/Steuer + EU-DB/Domains erst ab kommerziell
    trigger: str = ""         # Wann zum naechsten Schritt?


MILESTONES = [
    Milestone("M0 Hobby/Solo", "Jahr 0",
              ["pi5", "laptop", "rtx3080", "mini_m4"], 1, 0.0,
              trigger="Warmes Modell laeuft staendig / 8B zu klein -> mini M4 Pro (mehr RAM)."),
    Milestone("M1 Familie", "Jahr 0-1",
              ["pi5", "laptop", "rtx3080", "mini_m4pro"], 5, 0.0,
              trigger="32B zu klein oder >5 Nutzer -> 70B-Box (Mac Studio M4 Max)."),
    Milestone("M2 Erste Zahler", "Jahr 1-2",
              ["pi5", "laptop", "rtx3080", "studio_max", "rtx5090"], 12, 99.0,
              commercial=True,
              trigger="Warme Auslastung >60% oder Nutzer > Break-even -> 2. Inferenz-Knoten."),
    Milestone("M3 Multi-Node", "Jahr 2-4",
              ["pi5", "laptop", "rtx3080", "studio_max", "studio_ult", "rtx5090x2"], 35, 129.0,
              commercial=True,
              trigger="EU-Standort voll / Nachfrage US+Asien -> zweite Region."),
    Milestone("M4 Multi-Region", "Jahr 4+",
              ["pi5", "laptop", "studio_max", "studio_ult", "rtx5090x2"], 120, 199.0,
              regions=3, commercial=True,
              trigger="Skaliert ueber Regionen; Recht x Region wird zum Haupttreiber."),
]


def milestone_cost(ms: Milestone, util: float, legal_setup: float,
                   legal_yearly: float) -> dict:
    hw_mo = 0.0
    for k in ms.hw_keys:
        h = HW_BY_KEY[k]
        hw_mo += h.cost_mo(_plane_util(h.plane, util), amort=not h.owned)
    hw_mo *= ms.regions
    infra = (VPS_APP_EUR_MO + CLOUD_STORAGE_EUR_MO + INTERNET_EUR_MO
             + (EU_DB_HOST_EUR_MO + DOMAIN_EUR_YEAR / 12 if ms.commercial else 0.0)) * ms.regions
    legal = (legal_admin_eur_mo(legal_setup, legal_yearly, ms.regions)["total"]
             if ms.commercial else 0.0)
    total = hw_mo + infra + legal
    per_user = total / ms.users if ms.users else total
    margin = ms.price - per_user
    breakeven = math.ceil(total / ms.price) if ms.price > 0 else 0
    return dict(hw=hw_mo, infra=infra, legal=legal, total=total,
                per_user=per_user, margin=margin, breakeven=breakeven)


# ── 10b. Seed-Geräte für Freunde/Familie (idle -> Docker-Dienste fürs YHA-Netz) ─
# "Ein paar tolle Geräte" werden ans Umfeld gegeben: YPA trägt die ANSCHAFFUNG, der
# STROM läuft über den Gast-Haushalt (externalisiert, zählt NICHT in der YPA-Kasse),
# und im Idle steuern sie Docker-Dienste + ein kleines Modell zum Pool bei. Genuin
# nettes, leises, sparsames Gerät -> Freund/Familie hat echten Nutzen, Netz kriegt Idle.
SEED_DEVICES_DEFAULT = 2          # wie viele "tolle Geräte" fürs Umfeld einplanen
SEED_BOX_KEY         = "mini_m4"  # nettes Always-on-Gerät (Docker + ~8B idle), Strom beim Gast


def first_year_allin(ms: Milestone, util: float, legal_setup: float, legal_yearly: float,
                     seed_devices: int, seed_box_key: str) -> dict:
    """Echter Cash-Bedarf der ERSTEN 12 Monate (≠ amortisierte Monatssicht):
       Anschaffung KOMPLETT (nicht über 4J verteilt) + Strom 12 Mo + Infra/Netz 12 Mo
       + Recht (Setup voll + 1 Jahr) + Seed-Geräte fürs Umfeld (nur Anschaffung)."""
    R = ms.regions
    # Hardware: voller Kaufpreis, nur für NICHT bereits vorhandene Geräte (owned -> €0)
    capex = sum(HW_BY_KEY[k].price_eur for k in ms.hw_keys if not HW_BY_KEY[k].owned) * R
    # Strom 12 Mo: reale Last/Idle der Milestone-HW, je Ebene realistisch (ohne Amort)
    power = sum(HW_BY_KEY[k].tco_year(_plane_util(HW_BY_KEY[k].plane, util))["power"]
                for k in ms.hw_keys) * R
    # Infra/Netz 12 Mo: VPS + Cloud-Speicher + ein Internet je Standort (+ DB/Domains kommerziell)
    infra = (VPS_APP_EUR_MO + CLOUD_STORAGE_EUR_MO + INTERNET_EUR_MO
             + (EU_DB_HOST_EUR_MO + DOMAIN_EUR_YEAR / 12 if ms.commercial else 0.0)) * 12 * R
    legal_setup_cash = legal_setup * R if ms.commercial else 0.0
    legal_yearly_cash = legal_yearly * R if ms.commercial else 0.0
    # Seed-Geräte fürs Umfeld: ab Familie (>1 Nutzer); nur Anschaffung, Strom beim Gast
    n_seed = seed_devices if ms.users > 1 else 0
    seed_box = HW_BY_KEY.get(seed_box_key) or HW_BY_KEY[SEED_BOX_KEY]
    seed_capex = n_seed * seed_box.price_eur
    recurring = power + infra + legal_yearly_cash          # was Jahr 2+ kostet (ohne Re-Invest)
    total = capex + seed_capex + legal_setup_cash + recurring
    return dict(capex=capex, power=power, infra=infra, legal_setup=legal_setup_cash,
                legal_yearly=legal_yearly_cash, seed_capex=seed_capex, n_seed=n_seed,
                seed_box=seed_box, recurring=recurring, total=total)


# ── 11. Optionaler KI-Beistand (graceful: ohne Modell -> programmatische Reco)
def ai_endpoint():
    """(kind, url, key, model) des ersten erreichbaren Modells, sonst None. Keine Secrets im Code."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return ("anthropic", "https://api.anthropic.com/v1/messages",
                os.environ["ANTHROPIC_API_KEY"],
                os.environ.get("YPA_AI_MODEL", "claude-haiku-4-5-20251001"))
    base = os.environ.get("OPENAI_BASE_URL") or os.environ.get("OLLAMA_HOST")
    if base:
        if not base.startswith("http"):
            base = "http://" + base
        return ("openai", base.rstrip("/") + "/v1/chat/completions",
                os.environ.get("OPENAI_API_KEY", "sk-noauth"),
                os.environ.get("YPA_AI_MODEL", "llama3.1"))
    if os.environ.get("OPENAI_API_KEY"):
        return ("openai", "https://api.openai.com/v1/chat/completions",
                os.environ["OPENAI_API_KEY"],
                os.environ.get("YPA_AI_MODEL", "gpt-4o-mini"))
    return None


def ai_summarize(facts: str):
    """Best-effort: lass ein erreichbares Modell die Zahlen zusammenfassen. None bei Fehler."""
    ep = ai_endpoint()
    if not ep:
        return None
    kind, url, key, model = ep
    prompt = ("Du bist ein nuechterner Infrastruktur- und Business-Berater. Fasse die folgenden "
              "BEREITS BERECHNETEN Zahlen in 4-6 Saetzen auf Deutsch zusammen und gib eine klare "
              "Empfehlung (beste Box fuers Geld, ab wann es sich traegt, Eigenbesitz vs. Cloud, "
              "naechster sinnvoller Meilenstein). Erfinde KEINE neuen Zahlen.\n\n" + facts)
    try:
        if kind == "anthropic":
            body = json.dumps({"model": model, "max_tokens": 450,
                               "messages": [{"role": "user", "content": prompt}]}).encode()
            req = urllib.request.Request(url, data=body, headers={
                "content-type": "application/json", "x-api-key": key,
                "anthropic-version": "2023-06-01"})
        else:
            body = json.dumps({"model": model, "max_tokens": 450,
                               "messages": [{"role": "user", "content": prompt}]}).encode()
            req = urllib.request.Request(url, data=body, headers={
                "content-type": "application/json", "authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
        if kind == "anthropic":
            return data["content"][0]["text"].strip()
        return data["choices"][0]["message"]["content"].strip()
    except Exception:
        return None


def programmatic_reco(util: float) -> str:
    """Schlussfolgerungen rein programmatisch aus den Zahlen (Pfad 'ohne KI')."""
    inf = [h for h in HARDWARE if h.plane == "inference"]
    top = max(inf, key=lambda h: h.capability() / h.tco_year(util)["total"])
    sev = [h for h in inf if h.tps_70b >= FEELS_REAL_TPS]
    cheap70 = min(sev, key=lambda h: h.price_eur) if sev else None
    ctrl = [h for h in HARDWARE if h.plane == "control"]
    ctrl_mo = sum(h.cost_mo(_plane_util(h.plane, util), amort=not h.owned) for h in ctrl)
    L = [f"    - Bestes Faehigkeit-je-Euro @ {util*100:.0f}% Last: {top.name} "
         f"(Cap {top.capability():.0f} / {eur(top.tco_year(util)['total'])}/J)."]
    if cheap70:
        be = own_vs_rent_breakeven_h(cheap70)
        L.append(f"    - Guenstigste 70B-Box (>={FEELS_REAL_TPS:.0f} tok/s): {cheap70.name} "
                 f"({eur(cheap70.price_eur)}) — lohnt vs. Cloud ab ~{be:.0f} h/Mo Nutzung.")
    L.append(f"    - Control-Plane (Pi+Laptop, vorhanden): ~{eur(ctrl_mo)}/Mo Strom — "
             f"immer an, rechnet aber nicht.")
    L.append("    - Warm = 1 gepooltes Modell fuer alle; Bild/Beta bursty bzw. gemietet. "
             "Eigenbesitz nur bei echter Auslastung, sonst On-Demand-Cloud.")
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=float, default=40,
                    help="angenommene Sessions/Monat (Standard 40)")
    ap.add_argument("--load-hours", type=float, default=4.0,
                    help="Volllast-Stunden/Tag der lokalen Box")
    ap.add_argument("--nodes", type=int, default=4,
                    help="Anzahl Knoten im Fleet (Standard 4)")
    ap.add_argument("--gpus", type=int, default=2,
                    help="5090 je Knoten (Standard 2)")
    ap.add_argument("--util", type=float, default=0.5,
                    help="Auslastung 0–1 für die Fleet-Aufteilung (Standard 0.5)")
    ap.add_argument("--households", type=int, default=4,
                    help="beitragende Haushalte (Internet je Standort)")
    ap.add_argument("--users", type=int, default=12,
                    help="aktive Nutzer für die Pro-Kopf-Aufteilung")
    ap.add_argument("--regions", type=int, default=1,
                    help="Standorte/Jurisdiktionen (EU/US/Asien) — multipliziert Fleet + Recht")
    ap.add_argument("--beta-mode", choices=("on-demand", "local"), default="on-demand",
                    help="Beta-Slots gemietet (on-demand) oder lokal always-on (Standard on-demand)")
    ap.add_argument("--beta-hours", type=float, default=BETA_HOURS_MO,
                    help="Beta-Test-Stunden/Monat bei on-demand (Standard 40)")
    ap.add_argument("--legal-setup", type=float, default=LEGAL_SETUP_EUR,
                    help="einmalige Recht/Gründungskosten je Jurisdiktion (SCHÄTZUNG)")
    ap.add_argument("--legal-yearly", type=float, default=LEGAL_YEARLY_EUR,
                    help="laufende Recht/Steuer/Buchhaltung pro Jahr je Jurisdiktion (SCHÄTZUNG)")
    ap.add_argument("--price", type=float, default=99.0,
                    help="angebotener Verkaufspreis €/Nutzer/Monat für den Margen-Check")
    ap.add_argument("--seed-devices", type=int, default=SEED_DEVICES_DEFAULT,
                    help="„tolle Geräte\" für Freunde/Familie fürs Jahr-1-Budget "
                         "(idle -> Docker-Dienste fürs YHA-Netz; Strom beim Gast)")
    ap.add_argument("--seed-box", default=SEED_BOX_KEY,
                    help=f"HW-Key des Seed-Geräts (Default {SEED_BOX_KEY})")
    ap.add_argument("--ai", action="store_true",
                    help="Empfehlung von einem erreichbaren Modell zusammenfassen lassen "
                         "(ANTHROPIC_API_KEY oder OPENAI_BASE_URL/Ollama); sonst programmatisch")
    args = ap.parse_args()

    print(f"=== YPA-Kostenmodell  (Preisstand {PRICES_AS_OF}, Wien) ===\n")

    # 1) Gemessener Ist-Verbrauch ------------------------------------------------
    m = MEASURED
    list_cost = api_cost_eur(m["in_mtok"], m["out_mtok"], use_cache=False)
    cached    = api_cost_eur(m["in_mtok"], m["out_mtok"], use_cache=True)
    per_sess_list = list_cost / m["sessions"]
    per_sess_cached = cached / m["sessions"]
    print(f"[1] GEMESSEN: {m['sessions']} Sessions, {m['in_mtok']}M in / "
          f"{m['out_mtok']}M out  (~{m['days']} Tage)")
    print(f"    Opus-Kosten Listenpreis : {eur(list_cost)}  "
          f"(= {eur(per_sess_list)}/Session)")
    print(f"    Opus-Kosten mit Cache   : {eur(cached)}  "
          f"(= {eur(per_sess_cached)}/Session)\n")

    # 2) API-Jahreskosten je Nutzungsintensität ---------------------------------
    print(f"[2] API-JAHRESKOSTEN (Opus bleibt Cloud-only):")
    for spm in (args.sessions, 60, 120, 340):
        yearly_sessions = spm * 12
        y_list = per_sess_list * yearly_sessions
        y_cached = per_sess_cached * yearly_sessions
        tag = "  <- Sprint-Tempo" if spm == 340 else ""
        print(f"    {spm:>4.0f} Sessions/Monat -> Cache {eur(y_cached):>9} / "
              f"Liste {eur(y_list):>9} pro Jahr{tag}")
    print()

    # 3) Lokale Hardware (zusätzlich, ersetzt Opus NICHT) -----------------------
    print(f"[3] LOKALE BOX  (Amortisation 4J + Strom @ {EUR_PER_KWH} €/kWh, "
          f"{args.load_hours}h Last/Tag):")
    for box in BOXES.values():
        t = local_tco_eur_per_year(box, args.load_hours)
        print(f"    {box.name:<28} {eur(t['total']):>8}/J  "
              f"(Amort {eur(t['amort'])} + Strom {eur(t['electricity'])}, "
              f"{t['kwh_year']:.0f} kWh)")
        print(f"        -> {box.note}")
    print()

    # 4) Gemietete Server (Community-Fernzugriff) -------------------------------
    print(f"[4] GEMIETETE SERVER (App-Host, schnell wechselbar):")
    for n in (1, 2, 3):
        print(f"    {n}x VPS App-Host -> {eur(VPS_APP_EUR_MO*12*n)}/Jahr "
              f"({eur(VPS_APP_EUR_MO*n)}/Monat)")
    print(f"    GPU-Cloud on-demand: ${GPU_CLOUD_USD_HR}/h  "
          f"-> 24/7 ≈ ${GPU_CLOUD_USD_HR*24*365:,.0f}/Jahr (nur bei Bedarf mieten!)")
    print()
    # 5) Offene Modelle -> wie viele 5090 je Modellklasse -----------------------
    print(f"[5] OFFENE MODELLE -> wie viele 5090 (je {VRAM_PER_5090_GB} GB) pro Knoten:")
    for t in MODEL_TIERS:
        print(f"    {t.label:<24} {t.quant}  ~{t.weight_gb():>5.1f} GB Gewichte "
              f"-> {t.gpus()}x 5090   ({t.eu_open})")
    print("    Faustregel: 1x = 24–32B flott (Einzelnutzer), 2x = 70B/Mixtral (Sweet-Spot),")
    print("    3–4x = 123B / Q8 / lange Kontexte. EU-konform v.a. durch Self-Hosting:")
    print("    Inferenz-Daten verlassen den lokalen Standort nie (DSGVO/Daten-Residenz).\n")

    # 6) Fleet- & geteilte Always-on-Kosten -------------------------------------
    print(f"[6] FLEET ({args.nodes} Knoten x {args.gpus}x5090, immer an / live verfügbar):")
    print(f"    Pro Knoten je Auslastung (Amort 4J + Strom @ {EUR_PER_KWH} €/kWh):")
    for u in (0.25, 0.50, 0.75):
        c = node_cost_eur_mo(args.gpus, u)
        print(f"      {u*100:>3.0f}% Last -> {eur(c['total']):>7}/Mo  "
              f"(Amort {eur(c['amort'])} + Strom {eur(c['power'])}, {c['kwh']:.0f} kWh/Mo)")
    node = node_cost_eur_mo(args.gpus, args.util)
    shared = INTERNET_EUR_MO * args.households + CLOUD_STORAGE_EUR_MO + VPS_APP_EUR_MO
    fleet = node["total"] * args.nodes + shared
    cloud_24_7 = GPU_CLOUD_USD_HR * args.gpus * 24 * 30 / USD_PER_EUR
    print(f"    @ {args.util*100:.0f}% Auslastung, {args.households} Haushalte (Internet je Standort)")
    print(f"    + Cloud-Speicher {eur(CLOUD_STORAGE_EUR_MO)} + VPS-Frontend {eur(VPS_APP_EUR_MO)}:")
    print(f"      Fleet gesamt          : {eur(fleet)}/Monat")
    print(f"      je Knoten             : {eur(node['total'])}/Monat")
    print(f"      je Haushalt ({args.households})       : {eur(fleet / args.households)}/Monat")
    print(f"      je Nutzer ({args.users})         : {eur(fleet / args.users)}/Monat")
    print(f"    Vergleich: 1 Knoten ({args.gpus}x5090) 24/7 als Cloud-Miete ~ "
          f"{eur(cloud_24_7)}/Mo")
    print("    -> Eigenbesitz lohnt nur bei echter Auslastung; viel Idle => On-Demand billiger.\n")

    # 7) Public-Produkt-Roster: offene Modelle, je Prod + Beta-Slot --------------
    prod_gpus = sum(r.tier.gpus() for r in ROSTER)
    beta_gpus = sum(r.tier.gpus() for r in ROSTER if r.beta)
    print(f"[7] PRODUKT-ROSTER (offene Gewichte, je Prod + {'1 Beta-Slot' if beta_gpus else 'kein Beta'}):")
    for r in ROSTER:
        g = r.tier.gpus()
        beta_tag = " +Beta" if r.beta else ""
        print(f"    [{r.role:<9}] {r.tier.label:<20} {r.tier.quant} ~{r.tier.weight_gb():>4.0f}GB "
              f"-> {g}x5090{beta_tag:<6} ({r.tier.eu_open})")
    print(f"    Summe: Prod {prod_gpus}x 5090 (always-on lokal) + Beta {beta_gpus}x 5090\n")

    # 8) Recht/Steuer (AT) + Region-Multiplikator + Produkt-Gesamtrechnung -------
    R = args.regions
    prod = fleet_cost_mo(prod_gpus, args.gpus, args.util)
    prod_total = prod["total"] * R
    if args.beta_mode == "local":
        beta = fleet_cost_mo(beta_gpus, args.gpus, args.util)
        beta_total = beta["total"] * R
        beta_desc = f"{beta_gpus}x5090 lokal always-on ({beta['nodes']} Knoten) x{R} Region(en)"
    else:
        beta_total = beta_ondemand_eur_mo(beta_gpus, args.beta_hours)   # Cloud = global, x1
        beta_desc = f"{beta_gpus}x5090 on-demand @ {args.beta_hours:.0f}h/Mo (global, x1)"
    legal = legal_admin_eur_mo(args.legal_setup, args.legal_yearly, R)
    infra_mo = (VPS_APP_EUR_MO + EU_DB_HOST_EUR_MO + CLOUD_STORAGE_EUR_MO
                + DOMAIN_EUR_YEAR / 12 + INTERNET_EUR_MO) * R
    grand = prod_total + beta_total + legal["total"] + infra_mo
    per_user = grand / args.users
    margin = args.price - per_user
    breakeven_users = math.ceil(grand / args.price) if args.price > 0 else 0

    print(f"[8] PRODUKT-GESAMT ({R} Region(en), Beta={args.beta_mode}, "
          f"Opus-API NICHT enthalten):")
    print(f"    Prod-Fleet ({prod['nodes']} Knoten x {args.gpus}x5090 @ {args.util*100:.0f}%) x{R}"
          f" : {eur(prod_total):>8}/Mo")
    print(f"    Beta-Slots: {beta_desc}")
    print(f"        {'':36}: {eur(beta_total):>8}/Mo")
    print(f"    Recht/Steuer ({R} Juris.: Setup {eur(legal['setup_mo'])} + laufend "
          f"{eur(legal['yearly_mo'])})")
    print(f"        {'':36}: {eur(legal['total']):>8}/Mo")
    print(f"    EU-Infra (VPS+DB+Speicher+Domains+Netz) x{R}: {eur(infra_mo):>8}/Mo")
    print(f"    {'-'*52}")
    print(f"    GESAMT (ohne Opus-API)              : {eur(grand):>8}/Mo")
    print(f"    je Nutzer ({args.users})                      : {eur(per_user):>8}/Mo")
    print(f"    bei Preis {eur(args.price)}/Nutzer/Mo  -> Marge {eur(margin)}/Nutzer "
          f"({'TRÄGT sich' if margin >= 0 else 'DEFIZIT'}); "
          f"Break-even ab {breakeven_users} Nutzern")
    print(f"    Hinweis: Recht/Steuer sind SCHÄTZUNGEN — mit --legal-setup/--legal-yearly "
          f"echte Kanzlei-Zahlen einsetzen.\n")

    # 9) Hardware-Vergleich verschiedener Typen + Heim-vs-Cloud-Wertung ---------
    print(f"[9] HARDWARE-VERGLEICH (Q4 Einzel-Stream; TCO @ {args.util*100:.0f}% Last, Amort 4J):")
    for h in HARDWARE:
        p, t = h.best_model()
        bm = f"{p}B@{t:.0f}" if p else "—"
        tco = h.tco_year(args.util)["total"]
        be = own_vs_rent_breakeven_h(h)
        be_s = f"vs.Cloud ab {be:.0f}h/Mo" if be else "—"
        owned = " (vorhanden)" if h.owned else ""
        print(f"    {h.name:<26} {eur(h.price_eur):>7}{owned:<11} {h.mem_gb:>3}G "
              f"{h.bw_gbs:>4}GB/s  {bm:>7}  {eur(tco):>6}/J  Cap{h.capability():>5.0f}  {be_s}")
        print(f"        [{h.plane}] {h.role} — {h.note}")
    print()
    print("    HEIM vs. CLOUD — Wertung:")
    print("      + Datenresidenz/DSGVO (Daten verlassen Standort nie)   + keine Pro-Token-Kosten")
    print("      + niedrige Latenz, offline-faehig, uncensored erlaubt  + Gaming/Restwert (5090)")
    print("      - Capex + Ops + Idle; Cloud gewinnt bei bursty/Beta/wenig Nutzung.")
    print("      'vs.Cloud ab Xh/Mo' = ab so vielen Nutzungsstunden/Monat schlaegt die Box ihre Miete.")
    print("      Apple = grosse Modelle billig+leise (mittlere Bandbreite); NVIDIA = 3x schneller/Token,")
    print("      aber 32GB/Karte-Decke -> 70B erst mit 2 Karten (laut, stromhungrig).\n")

    # 10) Meilenstein-Leiter: Schritt fuer Schritt hochskalieren -----------------
    print("[10] MEILENSTEIN-LEITER (Hardware -> Kosten -> Preis -> Break-even):")
    for ms in MILESTONES:
        c = milestone_cost(ms, args.util, args.legal_setup, args.legal_yearly)
        roster = " + ".join(HW_BY_KEY[k].name.split(" (")[0] for k in ms.hw_keys)
        comm = " [kommerziell]" if ms.commercial else ""
        print(f"    {ms.name} ({ms.horizon}) — {ms.users} Nutzer, {ms.regions} Region(en){comm}")
        print(f"        HW: {roster}")
        legal_part = f" + Recht {eur(c['legal'])}" if ms.commercial else ""
        print(f"        Kosten {eur(c['total'])}/Mo (HW {eur(c['hw'])} + Infra {eur(c['infra'])}"
              f"{legal_part}) -> {eur(c['per_user'])}/Nutzer")
        if ms.price > 0:
            verdict = "traegt sich" if c["margin"] >= 0 else "DEFIZIT"
            print(f"        Preis {eur(ms.price)}/Nutzer -> Marge {eur(c['margin'])} ({verdict}), "
                  f"Break-even ab {c['breakeven']} Nutzern")
        else:
            print("        Preis €0 (Eigenbedarf / Kostenteilung)")
        print(f"        -> naechster Schritt: {ms.trigger}")
    print()

    # 11) Erstes Jahr — Vollkosten (Cash-out, Anschaffung NICHT amortisiert) -----
    print("[11] ERSTES JAHR — VOLLKOSTEN (Anschaffung voll + Strom + Internet + Infra, Cash):")
    print("     Hier zählt die Anschaffung KOMPLETT (statt über 4J verteilt) = echter")
    print("     Kapitalbedarf in den ersten 12 Monaten; danach bleibt nur das Laufende.")
    for ms in MILESTONES:
        y = first_year_allin(ms, args.util, args.legal_setup, args.legal_yearly,
                             args.seed_devices, args.seed_box)
        legal_part = (f" + Recht {eur(y['legal_setup'] + y['legal_yearly'])}"
                      if ms.commercial else "")
        seed_part = (f" + Seed {eur(y['seed_capex'])} ({y['n_seed']}x {y['seed_box'].name})"
                     if y['n_seed'] else "")
        print(f"    {ms.name} ({ms.users} Nutzer, {ms.regions} Region(en))")
        print(f"        Anschaffung {eur(y['capex'])} + Strom 12Mo {eur(y['power'])} + "
              f"Infra/Netz 12Mo {eur(y['infra'])}{legal_part}{seed_part}")
        print(f"        = JAHR 1 GESAMT: {eur(y['total']):>9}  "
              f"(ab Jahr 2 laufend ~{eur(y['recurring'])}/J, vor Re-Invest)")
    sb = HW_BY_KEY.get(args.seed_box) or HW_BY_KEY[SEED_BOX_KEY]
    print(f"    Seed-Geräte = „ein paar tolle Geräte\" fürs Umfeld ({args.seed_devices}x {sb.name} "
          f"je {eur(sb.price_eur)}): YPA zahlt nur")
    print(f"    die Anschaffung — der STROM läuft über den Gast-Haushalt (extern), und im Idle")
    print(f"    steuern sie Docker-Dienste + ein kleines Modell zum YHA-Netz bei. Tunen: "
          f"--seed-devices N --seed-box KEY.\n")

    # 12) Empfehlung: programmatisch, optional von einem Modell zusammengefasst --
    print("[12] EMPFEHLUNG:")
    facts = (f"Fleet-Gesamt (ohne Opus-API): {eur(grand)}/Mo, je Nutzer {eur(per_user)} "
             f"bei {args.users} Nutzern (Preis {eur(args.price)}, Break-even {breakeven_users}).\n"
             + "\n".join(
                 f"{h.name}: {eur(h.price_eur)}, {h.mem_gb}GB, "
                 f"{h.best_model()[0]}B@{h.best_model()[1]:.0f} tok/s, "
                 f"TCO {eur(h.tco_year(args.util)['total'])}/J"
                 for h in HARDWARE if h.plane == "inference")
             + "\n" + programmatic_reco(args.util))
    if args.ai:
        out = ai_summarize(facts)
        if out:
            for line in out.splitlines():
                print("    " + line)
            ep = ai_endpoint()
            print(f"    (KI-Zusammenfassung via {ep[0]}/{ep[3]} — Zahlen aus dem Modell oben.)")
        else:
            print("    (Kein Modell erreichbar — programmatische Empfehlung:)")
            print(programmatic_reco(args.util))
    else:
        print(programmatic_reco(args.util))
        print("    Tipp: --ai laesst ein erreichbares Modell (ANTHROPIC_API_KEY oder "
              "OPENAI_BASE_URL/Ollama) dies zusammenfassen; ohne Modell bleibt's programmatisch.")
    print()

    print("Fazit: Opus 4-8 gibt es nur über die API. Lokale Hardware liefert")
    print("offene Modelle (≠ Opus) + Gaming, senkt aber NICHT die Opus-Rechnung.")


if __name__ == "__main__":
    main()
