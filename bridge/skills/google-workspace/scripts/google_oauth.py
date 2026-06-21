"""Manual OAuth2 flow for YHA — bypasses google_auth_oauthlib auto-PKCE.

Desktop app OAuth clients registered with http://localhost redirect URIs
reject PKCE. This script generates auth URLs without the code_challenge
param and handles token exchange via raw requests.

Usage:
  python google_oauth.py auth-url
  python google_oauth.py exchange "http://localhost/?code=..."
"""
import json, secrets, sys
from urllib.parse import urlencode, parse_qs, urlparse
import requests
import base64
from pathlib import Path

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from _hermes_home import get_hermes_home

STATE_DIR = get_hermes_home()

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents.readonly",
]


def _b64(s: bytes) -> str:
    return base64.urlsafe_b64encode(s).rstrip(b"=").decode()


def auth_url():
    with open(STATE_DIR / "google_client_secret.json") as f:
        cs = json.load(f)["installed"]

    state = _b64(secrets.token_bytes(32))
    redirect = cs["redirect_uris"][0]  # Use registered redirect URI

    params = {
        "response_type": "code",
        "client_id": cs["client_id"],
        "redirect_uri": redirect,
        "scope": " ".join(SCOPES),
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
    }
    url = f"https://accounts.google.com/o/oauth2/auth?{urlencode(params)}"

    with open(STATE_DIR / "google_oauth_pending.json", "w") as f:
        json.dump({"state": state, "redirect_uri": redirect}, f)

    print(url)


def exchange(callback_url: str):
    params = parse_qs(urlparse(callback_url).query)
    code = params["code"][0]

    with open(STATE_DIR / "google_client_secret.json") as f:
        cs = json.load(f)["installed"]
    with open(STATE_DIR / "google_oauth_pending.json") as f:
        pending = json.load(f)

    r = requests.post("https://oauth2.googleapis.com/token", data={
        "code": code,
        "client_id": cs["client_id"],
        "client_secret": cs["client_secret"],
        "redirect_uri": pending["redirect_uri"],
        "grant_type": "authorization_code",
    })
    resp = r.json()

    if r.status_code != 200:
        print(f"ERROR {r.status_code}: {resp}")
        sys.exit(1)

    # Save in google_api.py-compatible format
    token = {
        "token": resp["access_token"],
        "refresh_token": resp.get("refresh_token"),
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": cs["client_id"],
        "client_secret": cs["client_secret"],
        "scopes": resp.get("scope", "").split() if isinstance(resp.get("scope"), str) else [],
    }
    with open(STATE_DIR / "google_token.json", "w") as f:
        json.dump(token, f, indent=2)

    pending_path = STATE_DIR / "google_oauth_pending.json"
    if pending_path.exists():
        pending_path.unlink()

    missing = sorted(s for s in SCOPES if s not in token["scopes"])
    if missing:
        print(f"WARNING: Missing scopes: {', '.join(missing)}")
    print(f"OK: Token saved to {STATE_DIR / 'google_token.json'}")


def check():
    try:
        with open(STATE_DIR / "google_token.json") as f:
            token = json.load(f)
        r = requests.get(
            "https://www.googleapis.com/oauth2/v1/tokeninfo",
            params={"access_token": token.get("token", "")},
        )
        if r.status_code == 200:
            print("AUTHENTICATED")
        else:
            print("TOKEN_INVALID")
    except FileNotFoundError:
        print("NOT_AUTHENTICATED")


def main():
    if len(sys.argv) < 2:
        print("Usage: google_oauth.py {auth-url|exchange|check} [args...]")
        sys.exit(1)

    action = sys.argv[1]
    if action == "auth-url":
        auth_url()
    elif action == "exchange":
        if len(sys.argv) < 3:
            print("Usage: google_oauth.py exchange CALLBACK_URL")
            sys.exit(1)
        exchange(sys.argv[2])
    elif action == "check":
        check()
    else:
        print(f"Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
