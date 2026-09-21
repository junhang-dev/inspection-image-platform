"""Readiness with frozen model identity; exit nonzero on failure or mismatch."""
import argparse
import json
import urllib.request

from ml.contract import DEFAULT_CONTRACT, check_health, read_contract


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--contract", default=str(DEFAULT_CONTRACT))
    args = parser.parse_args()
    try:
        # No proxy: this request must stay on the local loopback interface.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{args.port}/health", timeout=5) as response:
            health = json.load(response)
        check_health(health, read_contract(args.contract))
        print(json.dumps(health))
    except Exception as exc:
        print(json.dumps({"ready": False, "error": str(exc)}))
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
