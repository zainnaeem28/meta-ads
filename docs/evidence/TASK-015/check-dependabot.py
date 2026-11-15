"""Schema-check .github/dependabot.yml (SchemaStore dependabot-2.0 schema) and assert the DO-09 policy:
every update targets dev, runs weekly and is grouped. Usage: check-dependabot.py SCHEMA.json [dependabot.yml]"""
import json
import sys

import jsonschema
from ruamel.yaml import YAML

schema = json.load(open(sys.argv[1]))
path = sys.argv[2] if len(sys.argv) > 2 else ".github/dependabot.yml"
doc = json.loads(json.dumps(YAML(typ="safe").load(open(path))))
jsonschema.validate(doc, schema)
for u in doc["updates"]:
    name = u["package-ecosystem"] + " " + u["directory"]
    assert u.get("target-branch") == "dev", name + ": target-branch must be dev"
    assert u["schedule"]["interval"] == "weekly", name + ": must be weekly"
    assert u.get("groups"), name + ": must be grouped"
print("dependabot.yml: schema OK; %d updates, all target dev, weekly, grouped" % len(doc["updates"]))
