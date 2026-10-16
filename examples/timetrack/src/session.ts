import { LynError, type Session } from "@lyn/core"

declare module "@lyn/core" {
  interface Register {
    session: { userId: string; role: "admin" | "member" }
  }
}

export function signedIn(session: Session | null) {
  if (!session) throw new LynError("Sign in first")
  return session
}

export function admin(session: Session | null) {
  const user = signedIn(session)
  if (user.role !== "admin") throw new LynError("Only admins can change customers and projects")
  return user
}
