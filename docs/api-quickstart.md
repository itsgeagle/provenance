# Provenance API Quickstart — Querying the cohort from Python

This guide walks through authenticating with an API token and querying the
cohort list for a semester. Takes about 5 minutes.

## Prerequisites

- Python 3.9+
- `requests` library (`pip install requests`)
- A Provenance account with `admin` or `grader` role in at least one semester
- The Provenance server URL (e.g. `https://provenance.example.edu`)

## Step 1 — Mint an API token

Tokens are created via the web UI or directly from the API. To create one from
the command line, first log in via the browser to get a session cookie, then:

```bash
curl -s -X POST https://provenance.example.edu/api/v1/me/tokens \
  -H 'Content-Type: application/json' \
  -H 'Cookie: __Host-prov_sess=<your-session-cookie>' \
  -d '{
    "label": "quickstart-script",
    "scopes": {
      "read_only": true,
      "semester_ids": ["<your-semester-uuid>"]
    }
  }'
```

The response includes a `secret` field — **copy it now**, it will only be shown
once:

```json
{
  "token": {
    "id": "550e8400-...",
    "label": "quickstart-script",
    "scopes": { "read_only": true, "semester_ids": ["..."], "include_blobs": false }
  },
  "secret": "prov_abc123..."
}
```

Set the secret as an environment variable:

```bash
export PROVENANCE_TOKEN="prov_abc123..."
export PROVENANCE_BASE_URL="https://provenance.example.edu/api/v1"
export SEMESTER_ID="<your-semester-uuid>"
```

## Step 2 — Verify your token works

```python
import os
import requests

BASE_URL = os.environ["PROVENANCE_BASE_URL"]
TOKEN    = os.environ["PROVENANCE_TOKEN"]

headers = {"Authorization": f"Bearer {TOKEN}"}

me = requests.get(f"{BASE_URL}/me", headers=headers)
me.raise_for_status()
print("Logged in as:", me.json()["user"]["email"])
```

Expected output:

```
Logged in as: you@berkeley.edu
```

## Step 3 — Query the cohort with cursor pagination

The `/semesters/{semesterId}/submissions` endpoint returns up to 500 submissions
per page. Use the `cursor` query parameter to iterate through all pages.

```python
import os
import requests

BASE_URL    = os.environ["PROVENANCE_BASE_URL"]
TOKEN       = os.environ["PROVENANCE_TOKEN"]
SEMESTER_ID = os.environ["SEMESTER_ID"]

headers = {"Authorization": f"Bearer {TOKEN}"}

def get_all_submissions(semester_id: str, **filters) -> list[dict]:
    """Fetch all submissions for a semester using cursor pagination."""
    url = f"{BASE_URL}/semesters/{semester_id}/submissions"
    params = {"limit": 500, **filters}
    all_items = []

    while True:
        resp = requests.get(url, headers=headers, params=params)
        resp.raise_for_status()
        data = resp.json()

        all_items.extend(data["items"])
        print(f"  Fetched {len(all_items)} / {data['total_count']} submissions...")

        next_cursor = data.get("next_cursor")
        if next_cursor is None:
            break

        # Replace cursor param for the next page.
        params = {"limit": 500, "cursor": next_cursor, **filters}

    return all_items


# Fetch all submissions, no filter (skips superseded by default)
submissions = get_all_submissions(SEMESTER_ID)
print(f"\nTotal submissions: {len(submissions)}")

# Fetch only high-severity submissions
high_risk = get_all_submissions(SEMESTER_ID, severity_min="high")
print(f"High-risk submissions: {len(high_risk)}")
```

Sample output:

```
  Fetched 500 / 1247 submissions...
  Fetched 1000 / 1247 submissions...
  Fetched 1247 / 1247 submissions...

Total submissions: 1247
  Fetched 23 / 23 submissions...
High-risk submissions: 23
```

## Step 4 — Worked example end-to-end

The following script: fetches all submissions, counts flags by severity, and
prints a summary table.

```python
import os
import sys
import requests
from collections import Counter

BASE_URL    = os.environ.get("PROVENANCE_BASE_URL", "http://localhost:3000/api/v1")
TOKEN       = os.environ.get("PROVENANCE_TOKEN", "")
SEMESTER_ID = os.environ.get("SEMESTER_ID", "")

if not TOKEN or not SEMESTER_ID:
    sys.exit("Set PROVENANCE_TOKEN and SEMESTER_ID environment variables.")

headers = {"Authorization": f"Bearer {TOKEN}"}

# --- Fetch all submissions ---
url    = f"{BASE_URL}/semesters/{SEMESTER_ID}/submissions"
params = {"limit": 500}
items  = []
while True:
    resp = requests.get(url, headers=headers, params=params)
    resp.raise_for_status()
    data = resp.json()
    items.extend(data["items"])
    if data["next_cursor"] is None:
        break
    params = {"limit": 500, "cursor": data["next_cursor"]}

# --- Aggregate flag severity counts ---
severity_totals: Counter[str] = Counter()
for sub in items:
    fc = sub["flag_counts"]
    severity_totals["high"]   += fc["high"]
    severity_totals["medium"] += fc["medium"]
    severity_totals["low"]    += fc["low"]
    severity_totals["info"]   += fc["info"]

# --- Print summary ---
print(f"\nSemester: {SEMESTER_ID}")
print(f"Total submissions: {len(items)}")
print(f"\nFlag severity distribution:")
for sev in ["high", "medium", "low", "info"]:
    print(f"  {sev:>8}: {severity_totals[sev]:,}")

# Top 10 most flagged submissions
flagged = sorted(items, key=lambda s: s["score_total"], reverse=True)[:10]
print(f"\nTop 10 by risk score:")
for rank, sub in enumerate(flagged, 1):
    student = sub["student"]["sid"]
    assignment = sub["assignment"]["label"]
    score = sub["score_total"]
    severity = sub["score_max_severity"]
    print(f"  {rank:2}. {student} / {assignment} — score={score:.1f}, max_severity={severity}")
```

## Useful query parameters

| Parameter                 | Type    | Description                                                  |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `assignment_id`           | UUID    | Filter to one assignment                                     |
| `severity_min`            | string  | `info`, `low`, `medium`, or `high`                           |
| `validation_status`       | string  | `pass`, `warn`, or `fail`                                    |
| `score_min` / `score_max` | number  | Score range filter                                           |
| `include_superseded`      | boolean | Include older submissions (default: false)                   |
| `sort`                    | string  | `score_desc` (default), `student_asc`, `ingested_desc`, etc. |
| `limit`                   | int     | 1–500, default 50                                            |

## API reference

Full documentation at: `https://provenance.example.edu/api/v1/docs`

OpenAPI spec at: `https://provenance.example.edu/api/v1/openapi.json`
