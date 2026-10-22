// Keep execution hints off provider schemas and only trust tools marked by the local registry.
export const readOnlyTools = new WeakSet<object>()
