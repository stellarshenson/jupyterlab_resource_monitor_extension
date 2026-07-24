import json

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado


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


def setup_route_handlers(web_app, sampler):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    metrics_route_pattern = url_path_join(
        base_url, "jupyterlab-resource-monitor-extension", "metrics"
    )
    handlers = [(metrics_route_pattern, MetricsRouteHandler, {"sampler": sampler})]

    web_app.add_handlers(host_pattern, handlers)
