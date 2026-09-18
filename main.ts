import handler from "./src/index";

export default {
  fetch: (req: Request, env: Record<string, string>) =>
    (handler as { fetch: (r: Request, e: unknown) => Promise<Response> }).fetch(req, env),
};
