package main

// cost.go — `yha cost` subcommand.
//
// Bridge endpoint:
//
//	GET /v1/costs
//
// Registered by bridge/modules/observability-plus/costs.ts. Returns
// `{allTime: {total, byModel, byProvider}, daily: {YYYY-MM-DD: {total,
// byModel, byProvider}}}`. We always go through the daemon so the CLI
// stays filesystem-agnostic (works over the network too); the on-disk
// bridge/costs.json is never touched here.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"text/tabwriter"
	"time"
)

type costsResp struct {
	AllTime costBucket            `json:"allTime"`
	Daily   map[string]costBucket `json:"daily"`
}

type costBucket struct {
	Total      float64            `json:"total"`
	ByModel    map[string]float64 `json:"byModel"`
	ByProvider map[string]float64 `json:"byProvider"`
}

func runCost(args []string) int {
	fs := flag.NewFlagSet("cost", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	socket := fs.String("socket", "", "Unix socket path (default: discovered)")
	url := fs.String("url", os.Getenv("YHA_URL"), "remote yha-core URL")
	token := fs.String("token", os.Getenv("YHA_TOKEN"), "bearer token for --url")
	tokenFile := fs.String("token-file", "", "read bearer token from a file")
	outFlag := fs.String("out", "text", "output mode: text | json")
	timeout := fs.Duration("timeout", 30*time.Second, "request timeout")
	today := fs.Bool("today", false, "show only today's costs")
	week := fs.Bool("week", false, "group the last 7 days into a single row")
	model := fs.String("model", "", "filter to a single model id (e.g. claude-opus-4-7)")

	if err := fs.Parse(args); err != nil {
		return 2
	}

	pf := promptFlags{
		socket:    *socket,
		url:       *url,
		token:     *token,
		tokenFile: *tokenFile,
		out:       *outFlag,
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	resp, err := getRequest(ctx, pf, "/v1/costs")
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha cost:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha cost:", err)
		return 1
	}

	if *outFlag == "json" {
		os.Stdout.Write(body)
		if len(body) == 0 || body[len(body)-1] != '\n' {
			fmt.Println()
		}
		return 0
	}

	var parsed costsResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		fmt.Fprintln(os.Stderr, "yha cost: parse:", err)
		return 1
	}

	switch {
	case *today:
		printToday(os.Stdout, parsed, *model)
	case *week:
		printWeek(os.Stdout, parsed, *model)
	default:
		printDaily(os.Stdout, parsed, *model)
	}
	return 0
}

// printDaily lists every day in `daily` (most recent first), filtered by
// model when --model is set. Default view.
func printDaily(w io.Writer, c costsResp, model string) {
	days := make([]string, 0, len(c.Daily))
	for d := range c.Daily {
		days = append(days, d)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(days)))

	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	if model != "" {
		fmt.Fprintln(tw, "DAY\tMODEL\tCOST")
	} else {
		fmt.Fprintln(tw, "DAY\tTOTAL\tTOP MODELS")
	}
	if len(days) == 0 {
		fmt.Fprintln(tw, "-\t-\t-")
		_ = tw.Flush()
		return
	}
	var grand float64
	for _, d := range days {
		bucket := c.Daily[d]
		if model != "" {
			v := bucket.ByModel[model]
			if v == 0 {
				continue
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\n", d, model, fmtUSD(v))
			grand += v
			continue
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", d, fmtUSD(bucket.Total), topModels(bucket.ByModel, 3))
		grand += bucket.Total
	}
	fmt.Fprintf(tw, "TOTAL\t%s\t\n", fmtUSD(grand))
	_ = tw.Flush()

	if model == "" {
		fmt.Fprintln(w)
		fmt.Fprintf(w, "all-time total: %s\n", fmtUSD(c.AllTime.Total))
	}
}

// printToday picks today's bucket (UTC, matching the bridge's day key).
func printToday(w io.Writer, c costsResp, model string) {
	day := time.Now().UTC().Format("2006-01-02")
	bucket, ok := c.Daily[day]
	if !ok {
		fmt.Fprintf(w, "no costs recorded for %s\n", day)
		return
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MODEL\tCOST")
	models := sortedKeys(bucket.ByModel)
	for _, m := range models {
		if model != "" && m != model {
			continue
		}
		fmt.Fprintf(tw, "%s\t%s\n", m, fmtUSD(bucket.ByModel[m]))
	}
	if model == "" {
		fmt.Fprintf(tw, "TOTAL\t%s\n", fmtUSD(bucket.Total))
	}
	_ = tw.Flush()
}

// printWeek sums the last 7 days starting from today (UTC). Days that
// don't exist in `daily` are silently skipped.
func printWeek(w io.Writer, c costsResp, model string) {
	now := time.Now().UTC()
	total := 0.0
	byModel := map[string]float64{}
	for i := 0; i < 7; i++ {
		day := now.AddDate(0, 0, -i).Format("2006-01-02")
		b, ok := c.Daily[day]
		if !ok {
			continue
		}
		total += b.Total
		for k, v := range b.ByModel {
			byModel[k] += v
		}
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MODEL\tCOST (7-day)")
	models := sortedKeys(byModel)
	if model != "" {
		v := byModel[model]
		fmt.Fprintf(tw, "%s\t%s\n", model, fmtUSD(v))
	} else {
		for _, m := range models {
			fmt.Fprintf(tw, "%s\t%s\n", m, fmtUSD(byModel[m]))
		}
		fmt.Fprintf(tw, "TOTAL\t%s\n", fmtUSD(total))
	}
	_ = tw.Flush()
}

// topModels formats the top-N entries of a model→cost map as
// "model=$X.XX, model2=$Y.YY". Stable ordering: cost desc, then name.
func topModels(m map[string]float64, n int) string {
	if len(m) == 0 {
		return "-"
	}
	type kv struct {
		k string
		v float64
	}
	pairs := make([]kv, 0, len(m))
	for k, v := range m {
		pairs = append(pairs, kv{k, v})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].v != pairs[j].v {
			return pairs[i].v > pairs[j].v
		}
		return pairs[i].k < pairs[j].k
	})
	if len(pairs) > n {
		pairs = pairs[:n]
	}
	out := ""
	for i, p := range pairs {
		if i > 0 {
			out += ", "
		}
		out += fmt.Sprintf("%s=%s", p.k, fmtUSD(p.v))
	}
	return out
}

func sortedKeys(m map[string]float64) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func fmtUSD(v float64) string {
	return fmt.Sprintf("$%.2f", v)
}
