try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyterlab_resource_monitor_extension' outside a proper installation.")
    __version__ = "dev"
import atexit

from .kernels import KernelSampler
from .metrics import ResourceSampler
from .routes import setup_route_handlers


def _jupyter_labextension_paths():
    return [{
        "src": "labextension",
        "dest": "jupyterlab_resource_monitor_extension"
    }]


def _jupyter_server_extension_points():
    return [{
        "module": "jupyterlab_resource_monitor_extension"
    }]


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    sampler = ResourceSampler(log=server_app.log)
    sampler.start()
    # Idle until the kernel panel starts polling: with no watched kernel its
    # loop wakes, finds nothing to sample, and goes back to sleep.
    kernel_sampler = KernelSampler(log=server_app.log)
    kernel_sampler.start()
    # Daemon threads already die with the process; the atexit hooks stop the
    # sampling loops cleanly at interpreter shutdown so they are not left
    # spinning through a slow teardown.
    atexit.register(sampler.stop)
    atexit.register(kernel_sampler.stop)
    setup_route_handlers(server_app.web_app, sampler, kernel_sampler)
    name = "jupyterlab_resource_monitor_extension"
    server_app.log.info(f"Registered {name} server extension")
