"""
Job fetcher — runs twice daily via GitHub Actions.
Pulls cybersecurity jobs from Greenhouse, Lever, Ashby, SmartRecruiters, and Adzuna.
Filters for 'cybersecurity', 'information security', or 'security' in the JD body.
Excludes trashed jobs. Commits jobs.json to repo.
"""

import json
import os
import re
import hashlib
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
import requests
from html import unescape

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"
IST = timezone(timedelta(hours=5, minutes=30))


def load_json(name):
    with open(DATA / name) as f:
        return json.load(f)


def save_json(name, data):
    with open(DATA / name, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def job_id(company, title, url):
    """Stable hash so the same job from re-fetches doesn't duplicate."""
    base = f"{company.lower().strip()}|{title.lower().strip()}|{url.lower().strip()}"
    return hashlib.sha256(base.encode()).hexdigest()[:16]


def strip_html(html):
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    text = unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def matches_keywords(text, config):
    """JD body must contain one of the required keywords (case-insensitive).
    Title-based exclusions filter out sales/marketing/physical security roles."""
    if not text:
        return False
    lower = text.lower()
    required = config["keywords"]["required_any"]
    if not any(kw.lower() in lower for kw in required):
        return False
    return True


def title_excluded(title, config):
    if not title:
        return False
    lower = title.lower()
    for bad in config["keywords"]["exclude_if_any_in_title"]:
        if bad.lower() in lower:
            return True
    return False


def location_label(location_str, config):
    if not location_str:
        return "Unknown"
    loc = location_str.lower()
    for pref in config["location_preferences"]["preferred"]:
        if pref.lower() in loc:
            return location_str
    return location_str


def fetch_greenhouse(slug, config, max_per_source):
    """Greenhouse public board API — fully open, no key needed."""
    jobs = []
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    try:
        r = requests.get(url, timeout=20)
        if r.status_code != 200:
            return jobs, f"Greenhouse {slug}: HTTP {r.status_code}"
        data = r.json()
        company_name = slug.replace("-", " ").title()
        for j in data.get("jobs", [])[:max_per_source]:
            title = j.get("title", "")
            content = strip_html(j.get("content", ""))
            if title_excluded(title, config):
                continue
            if not matches_keywords(content + " " + title, config):
                continue
            jobs.append({
                "id": job_id(company_name, title, j.get("absolute_url", "")),
                "title": title,
                "company": company_name,
                "location": location_label(j.get("location", {}).get("name", ""), config),
                "description": content[:5000],
                "url": j.get("absolute_url", ""),
                "source": f"greenhouse:{slug}",
                "posted_at": j.get("updated_at", ""),
                "fetched_at": datetime.now(IST).isoformat(),
            })
        return jobs, None
    except Exception as e:
        return jobs, f"Greenhouse {slug}: {e}"


def fetch_lever(slug, config, max_per_source):
    """Lever public postings API — fully open."""
    jobs = []
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = requests.get(url, timeout=20)
        if r.status_code != 200:
            return jobs, f"Lever {slug}: HTTP {r.status_code}"
        data = r.json()
        company_name = slug.replace("-", " ").title()
        for j in data[:max_per_source]:
            title = j.get("text", "")
            description = strip_html(j.get("descriptionPlain", "") or j.get("description", ""))
            lists_text = " ".join(
                strip_html(item.get("content", ""))
                for lst in j.get("lists", [])
                for item in [{"content": lst.get("content", "")}]
            )
            full_body = description + " " + lists_text
            if title_excluded(title, config):
                continue
            if not matches_keywords(full_body + " " + title, config):
                continue
            categories = j.get("categories", {})
            jobs.append({
                "id": job_id(company_name, title, j.get("hostedUrl", "")),
                "title": title,
                "company": company_name,
                "location": location_label(categories.get("location", ""), config),
                "description": full_body[:5000],
                "url": j.get("hostedUrl", ""),
                "source": f"lever:{slug}",
                "posted_at": datetime.fromtimestamp(j.get("createdAt", 0) / 1000, IST).isoformat() if j.get("createdAt") else "",
                "fetched_at": datetime.now(IST).isoformat(),
            })
        return jobs, None
    except Exception as e:
        return jobs, f"Lever {slug}: {e}"


def fetch_ashby(slug, config, max_per_source):
    """Ashby public job board API."""
    jobs = []
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    try:
        r = requests.get(url, timeout=20)
        if r.status_code != 200:
            return jobs, f"Ashby {slug}: HTTP {r.status_code}"
        data = r.json()
        company_name = slug.replace("-", " ").title()
        for j in data.get("jobs", [])[:max_per_source]:
            title = j.get("title", "")
            description = strip_html(j.get("descriptionHtml", "") or j.get("descriptionPlain", ""))
            if title_excluded(title, config):
                continue
            if not matches_keywords(description + " " + title, config):
                continue
            jobs.append({
                "id": job_id(company_name, title, j.get("jobUrl", "")),
                "title": title,
                "company": company_name,
                "location": location_label(j.get("location", ""), config),
                "description": description[:5000],
                "url": j.get("jobUrl", "") or j.get("applyUrl", ""),
                "source": f"ashby:{slug}",
                "posted_at": j.get("publishedAt", ""),
                "fetched_at": datetime.now(IST).isoformat(),
            })
        return jobs, None
    except Exception as e:
        return jobs, f"Ashby {slug}: {e}"


def fetch_smartrecruiters(slug, config, max_per_source):
    """SmartRecruiters public posting API."""
    jobs = []
    list_url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit={max_per_source}"
    try:
        r = requests.get(list_url, timeout=20)
        if r.status_code != 200:
            return jobs, f"SmartRecruiters {slug}: HTTP {r.status_code}"
        data = r.json()
        for j in data.get("content", []):
            posting_id = j.get("id")
            title = j.get("name", "")
            if title_excluded(title, config):
                continue
            detail_url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{posting_id}"
            try:
                dr = requests.get(detail_url, timeout=15)
                if dr.status_code != 200:
                    continue
                d = dr.json()
                sections = d.get("jobAd", {}).get("sections", {})
                description = " ".join(
                    strip_html(sections.get(k, {}).get("text", ""))
                    for k in ("companyDescription", "jobDescription", "qualifications", "additionalInformation")
                )
                if not matches_keywords(description + " " + title, config):
                    continue
                location = j.get("location", {})
                loc_str = ", ".join(filter(None, [location.get("city"), location.get("country")]))
                jobs.append({
                    "id": job_id(slug, title, d.get("applyUrl", "") or d.get("ref", "")),
                    "title": title,
                    "company": slug.replace("-", " ").title(),
                    "location": location_label(loc_str, config),
                    "description": description[:5000],
                    "url": d.get("applyUrl", "") or f"https://jobs.smartrecruiters.com/{slug}/{posting_id}",
                    "source": f"smartrecruiters:{slug}",
                    "posted_at": j.get("releasedDate", ""),
                    "fetched_at": datetime.now(IST).isoformat(),
                })
            except Exception:
                continue
        return jobs, None
    except Exception as e:
        return jobs, f"SmartRecruiters {slug}: {e}"


def fetch_adzuna(config, max_per_source):
    """Adzuna India free API — needs APP_ID and APP_KEY env vars."""
    app_id = os.environ.get("ADZUNA_APP_ID")
    app_key = os.environ.get("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        return [], "Adzuna: skipped (no credentials)"
    jobs = []
    country = config.get("adzuna_country", "in")
    errors = []
    for term in config["search_terms_for_aggregators"]:
        url = f"https://api.adzuna.com/v1/api/jobs/{country}/search/1"
        params = {
            "app_id": app_id,
            "app_key": app_key,
            "what": term,
            "results_per_page": min(50, max_per_source),
            "content-type": "application/json",
        }
        try:
            r = requests.get(url, params=params, timeout=20)
            if r.status_code != 200:
                errors.append(f"Adzuna {term}: HTTP {r.status_code}")
                continue
            data = r.json()
            for j in data.get("results", []):
                title = j.get("title", "")
                description = strip_html(j.get("description", ""))
                if title_excluded(title, config):
                    continue
                if not matches_keywords(description + " " + title, config):
                    continue
                company_name = j.get("company", {}).get("display_name", "Unknown")
                jobs.append({
                    "id": job_id(company_name, title, j.get("redirect_url", "")),
                    "title": title,
                    "company": company_name,
                    "location": location_label(j.get("location", {}).get("display_name", ""), config),
                    "description": description[:5000],
                    "url": j.get("redirect_url", ""),
                    "source": f"adzuna:{term}",
                    "posted_at": j.get("created", ""),
                    "fetched_at": datetime.now(IST).isoformat(),
                })
        except Exception as e:
            errors.append(f"Adzuna {term}: {e}")
    return jobs, "; ".join(errors) if errors else None


def fetch_jsearch(config, max_per_source):
    """JSearch RapidAPI — aggregates LinkedIn/Indeed/Glassdoor. Needs RAPIDAPI_KEY."""
    key = os.environ.get("RAPIDAPI_KEY")
    if not key:
        return [], "JSearch: skipped (no RAPIDAPI_KEY)"
    jobs = []
    errors = []
    headers = {
        "X-RapidAPI-Key": key,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
    }
    for term in config["search_terms_for_aggregators"][:3]:  # limited to save quota
        url = "https://jsearch.p.rapidapi.com/search"
        params = {"query": f"{term} in India", "num_pages": "1"}
        try:
            r = requests.get(url, headers=headers, params=params, timeout=25)
            if r.status_code != 200:
                errors.append(f"JSearch {term}: HTTP {r.status_code}")
                continue
            data = r.json()
            for j in data.get("data", [])[:max_per_source]:
                title = j.get("job_title", "")
                description = j.get("job_description", "") or ""
                if title_excluded(title, config):
                    continue
                if not matches_keywords(description + " " + title, config):
                    continue
                jobs.append({
                    "id": job_id(j.get("employer_name", ""), title, j.get("job_apply_link", "")),
                    "title": title,
                    "company": j.get("employer_name", "Unknown"),
                    "location": location_label(j.get("job_city", "") + ", " + j.get("job_country", ""), config),
                    "description": description[:5000],
                    "url": j.get("job_apply_link", ""),
                    "source": f"jsearch:{term}",
                    "posted_at": j.get("job_posted_at_datetime_utc", ""),
                    "fetched_at": datetime.now(IST).isoformat(),
                })
        except Exception as e:
            errors.append(f"JSearch {term}: {e}")
    return jobs, "; ".join(errors) if errors else None


def main():
    config = load_json("config.json")
    trash = load_json("trash.json")
    existing = load_json("jobs.json")

    trashed_ids = set(trash.get("trashed_ids", []))
    existing_by_id = {j["id"]: j for j in existing.get("jobs", [])}

    new_jobs = []
    errors = []
    sources_run = []
    max_per = config["fetch_settings"]["max_jobs_per_source"]

    # Greenhouse
    for slug in config.get("greenhouse_companies", []):
        items, err = fetch_greenhouse(slug, config, max_per)
        new_jobs.extend(items)
        sources_run.append({"source": f"greenhouse:{slug}", "count": len(items), "error": err})
        if err:
            errors.append(err)

    # Lever
    for slug in config.get("lever_companies", []):
        items, err = fetch_lever(slug, config, max_per)
        new_jobs.extend(items)
        sources_run.append({"source": f"lever:{slug}", "count": len(items), "error": err})
        if err:
            errors.append(err)

    # Ashby
    for slug in config.get("ashby_companies", []):
        items, err = fetch_ashby(slug, config, max_per)
        new_jobs.extend(items)
        sources_run.append({"source": f"ashby:{slug}", "count": len(items), "error": err})
        if err:
            errors.append(err)

    # SmartRecruiters
    for slug in config.get("smartrecruiters_companies", []):
        items, err = fetch_smartrecruiters(slug, config, max_per)
        new_jobs.extend(items)
        sources_run.append({"source": f"smartrecruiters:{slug}", "count": len(items), "error": err})
        if err:
            errors.append(err)

    # Adzuna
    if config.get("use_adzuna"):
        items, err = fetch_adzuna(config, max_per)
        new_jobs.extend(items)
        sources_run.append({"source": "adzuna", "count": len(items), "error": err})
        if err:
            errors.append(err)

    # JSearch
    if config.get("use_jsearch"):
        items, err = fetch_jsearch(config, max_per)
        new_jobs.extend(items)
        sources_run.append({"source": "jsearch", "count": len(items), "error": err})
        if err:
            errors.append(err)

    # Dedupe (within run + against trash + against existing) and merge
    seen_ids = set()
    merged = {}

    # Carry over existing non-stale jobs
    stale_cutoff = datetime.now(IST) - timedelta(days=config["fetch_settings"]["stale_after_days"])
    for jid, j in existing_by_id.items():
        if jid in trashed_ids:
            continue
        try:
            fetched_at = datetime.fromisoformat(j.get("fetched_at", "").replace("Z", "+00:00"))
            if fetched_at < stale_cutoff:
                continue
        except Exception:
            pass
        merged[jid] = j

    # Add new ones
    for j in new_jobs:
        jid = j["id"]
        if jid in trashed_ids:
            continue
        if jid in seen_ids:
            continue
        seen_ids.add(jid)
        # Preserve original first-seen timestamp if we've seen this job before
        if jid in merged:
            j["fetched_at"] = merged[jid].get("fetched_at", j["fetched_at"])
        merged[jid] = j

    # Cap total size
    cap = config["fetch_settings"]["max_total_jobs_per_run"]
    job_list = sorted(merged.values(), key=lambda x: x.get("fetched_at", ""), reverse=True)[:cap]

    output = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "last_updated_ist": datetime.now(IST).strftime("%Y-%m-%d %H:%M IST"),
        "total_jobs": len(job_list),
        "sources_run": sources_run,
        "errors": errors,
        "jobs": job_list,
    }
    save_json("jobs.json", output)
    print(f"✓ Wrote {len(job_list)} jobs from {len([s for s in sources_run if s['count'] > 0])} active sources")
    print(f"✓ Errors: {len(errors)}")
    for e in errors[:5]:
        print(f"  - {e}")


if __name__ == "__main__":
    main()
