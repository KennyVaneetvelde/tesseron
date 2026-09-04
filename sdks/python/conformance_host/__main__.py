"""Entry point the ``@tesseron/conformance`` runner launches.

The runner starts one of these per fixture with ``TESSERON_CONFORMANCE_FIXTURE`` pointing at
the fixture document, waits for a single readiness line on stdout, then plays the gateway
against the endpoint that line names. Every diagnostic goes to stderr, because a second
stdout line fails the fixture.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import sys
import threading
from pathlib import Path
from typing import Final

from tesseron import HostError, ManifestPublication, TesseronApp

from . import UnsupportedFixtureError, fixture

FIXTURE_PATH_VARIABLE: Final = "TESSERON_CONFORMANCE_FIXTURE"


def main() -> int:
    """Runs one fixture and answers with the process exit code."""
    try:
        asyncio.run(_serve(_read_fixture()))
    except KeyboardInterrupt:
        return 0
    except (UnsupportedFixtureError, HostError, OSError) as problem:
        print(f"tesseron-conformance-host: {problem}", file=sys.stderr)
        return 1
    return 0


def _read_fixture() -> str:
    path = os.environ.get(FIXTURE_PATH_VARIABLE)
    if not path:
        raise UnsupportedFixtureError(f"{FIXTURE_PATH_VARIABLE} is required")
    return Path(path).read_text(encoding="utf-8")


async def _serve(document: str) -> None:
    app = TesseronApp(
        id="conformance",
        name="Tesseron Python conformance host",
        origin="tesseron-conformance://python",
        # The runner dials the endpoint it is told about and never reads discovery
        # manifests, so publishing one would only litter the developer's ~/.tesseron.
        manifest=ManifestPublication.disabled(),
    )
    fixture.register(app, document)

    host = await app.listen()
    _announce(host.url)
    await _wait_for_shutdown()
    await host.shutdown()


def _announce(url: str) -> None:
    """Writes the one readiness line the runner waits for.

    Flushed, so it cannot sit in a buffer while the runner times out.
    """
    sys.stdout.write(f"tesseron-conformance-url={url}\n")
    sys.stdout.flush()


async def _wait_for_shutdown() -> None:
    """Waits for the runner to ask the process to end.

    Closing stdin is the runner's normal signal; the interrupt and termination signals cover
    the force-kill path and a developer running the host by hand.
    """
    loop = asyncio.get_running_loop()
    ending: asyncio.Future[None] = loop.create_future()
    _watch_stdin(loop, ending)
    _watch_signals(loop, ending)
    await ending


def _watch_stdin(loop: asyncio.AbstractEventLoop, ending: asyncio.Future[None]) -> None:
    """Resolves ``ending`` once the runner closes this process's stdin.

    A daemon thread rather than ``loop.connect_read_pipe`` because Windows cannot select on
    a console handle, and rather than ``asyncio.to_thread`` because the default executor is
    joined on shutdown and this read only ends when the pipe does.
    """

    def read_until_closed() -> None:
        with contextlib.suppress(OSError, ValueError):
            sys.stdin.buffer.read()
        loop.call_soon_threadsafe(_finish, ending)

    threading.Thread(target=read_until_closed, name="conformance-stdin", daemon=True).start()


def _watch_signals(loop: asyncio.AbstractEventLoop, ending: asyncio.Future[None]) -> None:
    for number in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(number, _finish, ending)
        except NotImplementedError:
            # Windows has no loop signal handlers, and no SIGTERM worth the name. Ctrl+C
            # surfaces as KeyboardInterrupt out of asyncio.run instead.
            return


def _finish(ending: asyncio.Future[None]) -> None:
    if not ending.done():
        ending.set_result(None)


if __name__ == "__main__":
    raise SystemExit(main())
