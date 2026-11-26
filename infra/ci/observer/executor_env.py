"""Report the Contracts interpreter's actual imports under the executor's -I flag."""
import json
from importlib.metadata import PackageNotFoundError, version

packages = {}
for name in ("jsonschema", "referencing", "jsonschema-specifications", "attrs", "rpds-py"):
    try:
        packages[name] = version(name)
    except PackageNotFoundError:
        packages[name] = None

try:
    from jsonschema import Draft202012Validator, FormatChecker
    from referencing import Registry, Resource
except (ImportError, OSError):
    ready = False
    formats = []
else:
    ready = True
    formats = sorted(FormatChecker().checkers)

print(json.dumps({"jsonschema": packages["jsonschema"] if ready else None, "validator_ready": ready,
                  "validator_packages": packages, "validator_formats": formats}))
