import { handleRequest, type Env } from './mcp';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
