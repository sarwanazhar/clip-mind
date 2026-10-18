export class DurableObject {
  ctx: any;
  env: any;
  constructor(ctx: any, env: any) {
    this.ctx = ctx || {
      acceptWebSocket: () => {},
      getWebSockets: () => [],
    };
    this.env = env || {};
  }
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  ctx: any;
  env: Env;
  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
