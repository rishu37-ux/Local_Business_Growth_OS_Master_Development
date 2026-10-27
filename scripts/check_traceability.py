#!/usr/bin/env python3
"""Checks that requirement IDs stay consistent across the planning documents.

- Every requirement ID in REQUIREMENTS_BLUEPRINT.md is specified in SRS.md.
- Every SRS requirement has at least one numbered acceptance criterion.
- The traceability matrix lists exactly the SRS requirements.
Exit status 1 on any mismatch.
"""
import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"
ID = r"(?:FR-[A-Z]+-\d+|BR-T\d+|NFR-\d+)"


def srs_requirements(text):
    """Return {id: has_acceptance_criteria} for SRS headings and NFR table rows."""
    reqs = {}
    sections = re.split(r"^(?=### )", text, flags=re.M)
    for section in sections:
        m = re.match(rf"### ({ID}) ", section)
        if m:
            reqs[m.group(1)] = bool(re.search(r"^\d+\. \S", section, re.M))
    for m in re.finditer(rf"^\| ({ID}) \| [^|]+ \| ([^|]*) \|", text, re.M):
        reqs[m.group(1)] = bool(m.group(2).strip())
    return reqs


def main():
    blueprint = (DOCS / "REQUIREMENTS_BLUEPRINT.md").read_text()
    srs = srs_requirements((DOCS / "SRS.md").read_text())
    matrix = set(re.findall(rf"^\| ({ID}) \|", (DOCS / "REQUIREMENTS_TRACEABILITY.md").read_text(), re.M))
    blueprint_ids = set(re.findall(ID, blueprint))

    problems = []
    problems += [f"blueprint ID not specified in SRS: {i}" for i in sorted(blueprint_ids - srs.keys())]
    problems += [f"SRS requirement without acceptance criteria: {i}" for i, ok in sorted(srs.items()) if not ok]
    problems += [f"SRS requirement missing from traceability matrix: {i}" for i in sorted(srs.keys() - matrix)]
    problems += [f"traceability row not in SRS: {i}" for i in sorted(matrix - srs.keys())]

    for p in problems:
        print(f"FAIL    {p}")
    if not problems:
        print(f"ok      {len(srs)} SRS requirements with acceptance criteria; "
              f"{len(blueprint_ids)} blueprint IDs covered; matrix matches SRS")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
