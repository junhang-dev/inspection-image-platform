"""Start the frozen model in foreground; Ctrl-C stops only this process."""
import argparse
import json
import os
from pathlib import Path

from ml.contract import DEFAULT_CONTRACT, load_verified_predictor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", default=os.environ.get("MODEL_PATH", str(Path(__file__).parent / "artifacts/finetune.local/model.pt")))
    parser.add_argument("--contract", default=str(DEFAULT_CONTRACT))
    parser.add_argument("--host", choices=["127.0.0.1", "0.0.0.0"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--check", action="store_true", help="Verify weights and identity without listening or evaluating images")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    checkpoint, contract_path = Path(args.checkpoint).resolve(), Path(args.contract).resolve()
    if args.check:
        _, identity = load_verified_predictor(checkpoint, contract_path)
        print(json.dumps({"verified": True, **identity}))
        return
    os.environ["MODEL_PATH"] = str(checkpoint)
    os.environ["MODEL_CONTRACT_FILE"] = str(contract_path)
    os.environ["MODEL_REQUIRE_CONTRACT"] = "1"
    import uvicorn
    uvicorn.run("ml.service:app", host=args.host, port=args.port, workers=1, access_log=False)


if __name__ == "__main__":
    main()
