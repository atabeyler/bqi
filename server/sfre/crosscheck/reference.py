"""
Independent, stdlib-only reference implementations used to cross-check the JavaScript SFRE engines
(server/src/sfre/tests/crosscheck.test.js). Deliberately written from the equations in
docs/sfre/MATHEMATICAL_SPECIFICATION.md, not translated from the JS code.
Reads {"op": ..., "args": ...} JSON on stdin; writes {"result": ...} JSON on stdout.
"""
import json
import math
import sys


def hhi(w):
    return sum(x * x for x in w)


def overlap(a, b):
    keys = set(a) | set(b)
    return sum(min(a.get(k, 0.0), b.get(k, 0.0)) for k in keys)


def amihud(prices, volumes):
    vals = []
    for i in range(1, len(prices)):
        dv = prices[i] * volumes[i]
        if dv > 0 and prices[i - 1] > 0 and prices[i] > 0:
            vals.append(abs(math.log(prices[i] / prices[i - 1])) / dv)
    return sum(vals) / len(vals)


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def robust_z(x, ref):
    m = median(ref)
    mad = median([abs(v - m) for v in ref])
    return (x - m) / (1.4826 * mad)


def expected_shortfall(pnl, alpha):
    losses = sorted((-p for p in pnl), reverse=True)
    k = max(1, math.ceil((1 - alpha) * len(losses) - 1e-9))
    return sum(losses[:k]) / k


def beneish(t, p):
    def gm(x): return (x["revenue"] - x["cogs"]) / x["revenue"]
    def aq(x): return 1 - (x["current_assets"] + x["ppe"] + x["securities"]) / x["total_assets"]
    def dep(x): return x["depreciation"] / (x["depreciation"] + x["ppe"])
    def lev(x): return (x["current_liabilities"] + x["lt_debt"]) / x["total_assets"]
    dsri = (t["receivables"] / t["revenue"]) / (p["receivables"] / p["revenue"])
    gmi = gm(p) / gm(t)
    aqi = aq(t) / aq(p)
    sgi = t["revenue"] / p["revenue"]
    depi = dep(p) / dep(t)
    sgai = (t["sga"] / t["revenue"]) / (p["sga"] / p["revenue"])
    tata = (t["net_income"] - t["cfo"]) / t["total_assets"]
    lvgi = lev(t) / lev(p)
    return (-4.84 + 0.920 * dsri + 0.528 * gmi + 0.404 * aqi + 0.892 * sgi
            + 0.115 * depi - 0.172 * sgai + 4.679 * tata - 0.327 * lvgi)


def cascade_conservation_two_assets(args):
    """Closed-form one-round check: single fund, single asset, linear impact d=min(1,illiq*Q), pro-rata sale.
    Fund: cash c, shares q, price p; redemption R (TRY). Round 0 only (no secondary channel, no debt).
    Returns (sale value, price decline, loss on remaining holdings)."""
    c, q, p, r, illiq = args["cash"], args["shares"], args["price"], args["redemption"], args["illiq"]
    use = min(c, r)
    shortfall = r - use
    sale = min(shortfall, q * p)
    d = min(1.0, illiq * sale)
    remaining = q - sale / p
    loss = remaining * p * d
    return {"sale": sale, "d": d, "loss": loss}


OPS = {
    "hhi": lambda a: hhi(a["w"]),
    "overlap": lambda a: overlap(a["a"], a["b"]),
    "amihud": lambda a: amihud(a["prices"], a["volumes"]),
    "robust_z": lambda a: robust_z(a["x"], a["ref"]),
    "es": lambda a: expected_shortfall(a["pnl"], a["alpha"]),
    "beneish": lambda a: beneish(a["t"], a["p"]),
    "cascade_one_round": cascade_conservation_two_assets,
}

if __name__ == "__main__":
    req = json.load(sys.stdin)
    print(json.dumps({"result": OPS[req["op"]](req["args"])}))
