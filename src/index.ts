import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { requestAPI } from './request';

/**
 * Initialization data for the jupyterlab_resource_monitor_extension extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_resource_monitor_extension:plugin',
  description: 'Jupyterlab extension to replace jupyter-resource-usage with less intrusive and better implementation for resource usage',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    console.log('JupyterLab extension jupyterlab_resource_monitor_extension is activated!');

    requestAPI<any>('hello', app.serviceManager.serverSettings)
      .then(data => {
        console.log(data);
      })
      .catch(reason => {
        console.error(
          `The jupyterlab_resource_monitor_extension server extension appears to be missing.\n${reason}`
        );
      });
  }
};

export default plugin;
