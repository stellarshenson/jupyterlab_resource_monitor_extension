import json

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado

from .kernels import empty_snapshot


class MetricsRouteHandler(APIHandler):
    """Returns the latest cached resource snapshot.

    Never collects metrics inline - the sampler thread owns collection, so
    this handler's cost is constant regardless of system state.
    """

    def initialize(self, sampler):
        self._sampler = sampler

    @tornado.web.authenticated
    def get(self):
        self.finish(json.dumps(self._sampler.snapshot()))


class KernelsRouteHandler(APIHandler):
    """Returns the cached sample for one kernel, named by the caller.

    Each request also renews the sampler's lease on that kernel, so sampling
    happens only while the panel is open and polling. The handler itself only
    resolves a PID from the in-memory kernel manager and reads the cache - the
    process-tree walk runs on the sampler thread, never in this coroutine.
    """

    def initialize(self, kernel_sampler):
        self._kernel_sampler = kernel_sampler

    @tornado.web.authenticated
    def get(self):
        kernel_id = self.get_query_argument("kernel_id", default="")
        # An absent id, an unknown kernel, or one with no local process (a
        # remote kernel) all mean the same thing: nothing to walk and no watch
        # to register. The sampler already yields that payload for an id it
        # holds no sample for, so the shape is defined in one place.
        if not kernel_id:
            self.finish(json.dumps(empty_snapshot()))
            return

        name, pid = self._resolve(kernel_id)
        if pid is None:
            self.finish(json.dumps(empty_snapshot()))
            return

        self._kernel_sampler.watch(kernel_id, name, pid)
        self.finish(json.dumps(self._kernel_sampler.snapshot(kernel_id)))

    def _resolve(self, kernel_id):
        """Look up a kernel's kernelspec name and PID - in-memory, no I/O."""
        manager = self.kernel_manager
        # membership first: the server's manager raises a tornado 404 from
        # get_kernel for an unknown id, and a stale id from a closed notebook
        # is an empty panel, not an error
        if kernel_id not in manager:
            return "", None
        kernel = manager.get_kernel(kernel_id)
        name = getattr(kernel, "kernel_name", "") or ""
        provisioner = getattr(kernel, "provisioner", None)
        pid = getattr(provisioner, "pid", None)
        return name, pid


def setup_route_handlers(web_app, sampler, kernel_sampler):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    metrics_route_pattern = url_path_join(
        base_url, "jupyterlab-resource-monitor-extension", "metrics"
    )
    kernels_route_pattern = url_path_join(
        base_url, "jupyterlab-resource-monitor-extension", "kernels"
    )
    handlers = [
        (metrics_route_pattern, MetricsRouteHandler, {"sampler": sampler}),
        (
            kernels_route_pattern,
            KernelsRouteHandler,
            {"kernel_sampler": kernel_sampler},
        ),
    ]

    web_app.add_handlers(host_pattern, handlers)
