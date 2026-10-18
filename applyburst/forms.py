"""Small, validated workflow IR. Models select mappings; they never supply candidate facts."""
import hashlib
import json

PROFILE = {"name": "Demo Candidate", "email": "candidate@example.test", "phone": "+10000000000",
           "website": "https://example.test/portfolio", "location": "Istanbul", "work_authorized": "Yes"}

FIELDS = [
    {"name": "full_name", "label": "Full name", "required": True, "kind": "text"},
    {"name": "email", "label": "Email address", "required": True, "kind": "email"},
    {"name": "phone", "label": "Phone number", "required": True, "kind": "tel"},
    {"name": "portfolio", "label": "Portfolio URL", "required": True, "kind": "url"},
    {"name": "city", "label": "Current city", "required": True, "kind": "text"},
    {"name": "authorization", "label": "Authorized to work?", "required": True, "kind": "select",
     "options": ["Yes", "No"]},
]
EXPECTED = {"full_name": "name", "email": "email", "phone": "phone", "portfolio": "website",
            "city": "location", "authorization": "work_authorized"}


def fingerprint(fields=FIELDS):
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def validate_plan(plan, fields=FIELDS, profile=PROFILE):
    if not isinstance(plan, dict) or set(plan) != {"mapping"} or not isinstance(plan["mapping"], dict):
        raise ValueError("Plan must contain only a mapping object")
    mapping = plan["mapping"]
    known = {f["name"]: f for f in fields}
    if set(mapping) != set(known):
        raise ValueError("Plan must cover exactly the observed fields")
    for field, key in mapping.items():
        if key not in profile or profile[key] in (None, ""):
            raise ValueError(f"Missing approved profile fact: {field}")
        options = known[field].get("options")
        if options and profile[key] not in options:
            raise ValueError(f"Profile value not in options: {field}")
    return mapping


def known_answers(fields=FIELDS, profile=PROFILE):
    # Hand-authored adapter. Unknown required questions are returned for user input.
    if {f["name"] for f in fields} != set(EXPECTED):
        raise ValueError("Unrecognized form schema; input or a new verified plan is required")
    mapping = validate_plan({"mapping": EXPECTED}, fields, profile)
    return {field: profile[key] for field, key in mapping.items()}
