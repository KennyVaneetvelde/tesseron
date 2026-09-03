"""Host adapter for the ``@tesseron/conformance`` runner.

This package sits beside ``src/tesseron`` rather than inside it and imports the published
package like any other consumer, so the wheel carries the SDK and nothing else.
"""

from __future__ import annotations

__all__ = ["UnsupportedFixtureError"]


class UnsupportedFixtureError(Exception):
    """A fixture asks for behaviour this host cannot serve.

    Raised at launch rather than answered at runtime: a capability the host does not have
    should fail the run visibly instead of leaving a fixture that quietly passed.
    """
