"""
Shared data loader for the nflverse stat scripts.

WHY THIS EXISTS
`nfl_data_py` builds its own download URLs, and those URLs now 404 for the
current season even though the data is published. It also pins numpy<2.0,
which forces awkward dependency resolution. Both point to it being
unmaintained. `nflreadpy` is the actively maintained Python reader for the
same nflverse datasets (the counterpart to `nflreadr` in R), so it is tried
first and `nfl_data_py` is kept only as a fallback.

A NOTE ON UNCERTAINTY
The exact `nflreadpy` function names and return type are not verified here, so
this module discovers them at runtime rather than assuming: it probes a list of
plausible names, prints what the package actually exposes when none match, and
normalizes whatever it gets (polars or pandas) to a pandas DataFrame. That way
a wrong guess produces a useful log line instead of a stack trace.
"""
import sys
import urllib.error


def _to_pandas(df):
    """Normalize a polars or pandas frame to pandas.

    nflreadpy returns polars frames; the existing scripts are written against
    pandas. Rather than rewrite them, convert at the boundary.
    """
    if df is None:
        return None
    # Already pandas
    if hasattr(df, "iterrows") and hasattr(df, "columns"):
        return df
    # Polars exposes to_pandas()
    if hasattr(df, "to_pandas"):
        try:
            return df.to_pandas()
        except Exception as e:
            print(f"  to_pandas() failed: {type(e).__name__}: {e}")
            return None
    print(f"  unrecognized frame type: {type(df)}")
    return None


def _describe_api(mod, modname):
    """Print the callables a module exposes, so a failed guess is informative."""
    names = [n for n in dir(mod) if not n.startswith("_") and callable(getattr(mod, n, None))]
    print(f"  {modname} exposes: {sorted(names)}")


def _try_nflreadpy(kind, season):
    """kind is 'weekly' or 'pbp'."""
    try:
        import nflreadpy as nfl
    except ImportError:
        print("  nflreadpy not installed")
        return None

    # Candidate function names, most likely first. Probed rather than assumed.
    candidates = {
        "weekly": ["load_player_stats", "load_weekly_data", "load_player_stats_weekly"],
        "pbp": ["load_pbp", "load_pbp_data"],
    }[kind]

    fn = None
    fname = None
    for name in candidates:
        if hasattr(nfl, name):
            fn = getattr(nfl, name)
            fname = name
            break

    if fn is None:
        print(f"  nflreadpy has none of {candidates}")
        _describe_api(nfl, "nflreadpy")
        return None

    # Argument name also varies across versions; try the likely forms.
    for kwargs in ({"seasons": [season]}, {"seasons": season}, {"years": [season]}):
        try:
            print(f"  nflreadpy.{fname}({kwargs})")
            df = _to_pandas(fn(**kwargs))
            if df is not None and len(df):
                print(f"  OK via nflreadpy.{fname}: {len(df)} rows")
                return df
            if df is not None:
                print("  returned 0 rows")
        except TypeError as e:
            print(f"  signature mismatch: {e}")
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}")
            return None
        except Exception as e:
            print(f"  {type(e).__name__}: {e}")
    return None


def _try_nfl_data_py(kind, season):
    try:
        import nfl_data_py as nfl
    except ImportError:
        print("  nfl_data_py not installed")
        return None
    fn = nfl.import_weekly_data if kind == "weekly" else nfl.import_pbp_data
    try:
        df = fn([season], downcast=True)
        if df is not None and len(df):
            print(f"  OK via nfl_data_py: {len(df)} rows")
            return df
        print("  returned 0 rows")
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} (nfl_data_py's URL path is likely stale)")
    except Exception as e:
        print(f"  {type(e).__name__}: {e}")
    return None


def load(kind, season, fallback_seasons=2):
    """Load 'weekly' or 'pbp' data for a season, trying nflreadpy then
    nfl_data_py, then walking back earlier seasons.

    Returns (DataFrame, season_used) or (None, None).
    """
    assert kind in ("weekly", "pbp")
    for yr in range(season, season - fallback_seasons - 1, -1):
        print(f"\n=== {kind} data, season {yr} ===")
        print(" trying nflreadpy:")
        df = _try_nflreadpy(kind, yr)
        if df is not None and len(df):
            return df, yr
        print(" trying nfl_data_py:")
        df = _try_nfl_data_py(kind, yr)
        if df is not None and len(df):
            return df, yr
    print(
        "\nNo season resolved through either package. Check the workflow log above\n"
        "for the API surface each package exposes.",
        file=sys.stderr,
    )
    return None, None
