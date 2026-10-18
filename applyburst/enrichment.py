"""Conservative, explainable normalization. Unknown information stays unknown."""
import html
import re
from html.parser import HTMLParser


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.skip += 1
        if tag in {"p", "div", "li", "br", "h1", "h2", "h3", "ul"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.skip = max(0, self.skip-1)
        if tag in {"p", "div", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, value):
        if not self.skip:
            self.parts.append(value)


def plain_text(value):
    value = str(value or "")
    for _ in range(2):
        decoded = html.unescape(value)
        if decoded == value:
            break
        value = decoded
    parser = TextParser()
    parser.feed(value)
    text = ''.join(parser.parts)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[^\S\n]+", " ", text)).strip()


SKILLS = {
    "Python": r"\bpython\b", "JavaScript": r"\bjavascript\b|\bjs\b", "TypeScript": r"\btypescript\b",
    "Java": r"\bjava\b", "Go": r"\bgolang\b", "C++": r"(?<!\w)c\+\+(?!\w)",
    "C#": r"(?<!\w)c#(?!\w)", ".NET": r"(?<!\w)\.net\b|\bdotnet\b",
    "Rust": r"\brust\b", "SQL": r"\bsql\b", "PostgreSQL": r"\bpostgres(?:ql)?\b",
    "React": r"\breact(?:js)?\b", "Node.js": r"\bnode\.?js\b", "Django": r"\bdjango\b",
    "FastAPI": r"\bfastapi\b", "AWS": r"\baws\b|amazon web services", "Azure": r"\bazure\b",
    "GCP": r"\bgcp\b|google cloud", "Docker": r"\bdocker\b", "Kubernetes": r"\bkubernetes\b|\bk8s\b",
    "Terraform": r"\bterraform\b", "Linux": r"\blinux\b", "Spark": r"\b(?:apache )?spark\b",
    "Kafka": r"\bkafka\b", "Redis": r"\bredis\b", "MongoDB": r"\bmongodb\b",
    "PyTorch": r"\bpytorch\b", "TensorFlow": r"\btensorflow\b", "Machine learning": r"machine learning|makine öğrenmesi",
    "Computer vision": r"computer vision|bilgisayarlı görü", "NLP": r"\bnlp\b|natural language processing",
    "LLM": r"\bllms?\b|large language models?", "Distributed systems": r"distributed systems?",
    "C": r"(?<!\w)c programming|\bprogramming in c\b", "Unity": r"\bunity\b", "Unreal": r"\bunreal\b",
}


def enrich(title, description, location, explicit_workplace=None, employment_type=None):
    text = title + "\n" + description
    skills = [label for label, pattern in SKILLS.items() if re.search(pattern, text, re.I)]
    if re.search(r"\bGo\b(?=\s*[,/)]|\s+(?:programming|language))|(?:with|in|using|of|and|or)\s+Go\b", text) and "Go" not in skills:
        skills.append("Go")
    signals = {}
    workplace = "unknown"
    explicit = str(explicit_workplace or "").lower()
    if explicit in {"remote", "hybrid", "on-site", "onsite"}:
        workplace = "onsite" if explicit in {"on-site", "onsite"} else explicit
        signals["workplace"] = {"method": "provider_field", "text": explicit}
    else:
        for value, pattern in [("hybrid", r"hybrid|hibrit"), ("remote", r"remote|uzaktan"),
                               ("onsite", r"on.?site|in.office|ofisten")]:
            if re.search(pattern, location + " " + title, re.I):
                workplace = value
                signals["workplace"] = {"method": "location_or_title", "text": location + " · " + title}
                break
    seniority = "unknown"
    for value, pattern in [("intern", r"\bintern(?:ship)?\b|stajyer|\bstaj\b"),
                           ("lead", r"\bstaff\b|\bprincipal\b|\blead\b|\bdirector\b|\bhead\b"),
                           ("senior", r"\bsenior\b|\bsr\.?\b|kıdemli"),
                           ("junior", r"\bjunior\b|\bjr\.?\b|new.grad|entry.level|graduate")]:
        if re.search(pattern, title, re.I):
            seniority = value
            signals["seniority"] = {"method": "title_rule", "text": title}
            break
    kind = "unknown"
    source_type = str(employment_type or "")
    for value, pattern in [("intern", r"intern|staj"), ("part-time", r"part.?time"),
                           ("contract", r"contract|temporary|freelance"), ("full-time", r"full.?time")]:
        if re.search(pattern, source_type, re.I):
            kind = value
            signals["employment_type"] = {"method": "provider_field", "text": source_type}
            break
    return {"skills": tuple(skills), "workplace": workplace, "seniority": seniority,
            "employment_type": kind, "signals": signals}
