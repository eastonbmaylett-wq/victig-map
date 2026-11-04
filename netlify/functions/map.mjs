import { handle } from '../server/app.mjs';

export default handle;
export const config = {
  path: ['/county-data.json', '/site-config.json', '/admin/:action', '/automation/*', '/api/*'],
};
