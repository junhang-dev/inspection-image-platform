import { AsyncLocalStorage } from "node:async_hooks";

const principals = new AsyncLocalStorage();

export const currentPrincipal = () => principals.getStore() ?? null;
export const withPrincipal = (user, callback) => principals.run(user, callback);
