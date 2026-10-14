export interface User {
  id: string
  name: string
}

export interface List {
  id: string
  ownerId: string
  name: string
  createdAt: Date
}

export interface Todo {
  id: string
  listId: string
  text: string
  done: boolean
  createdAt: Date
}

export interface Activity {
  id: string
  userId: string
  message: string
  createdAt: Date
}

declare module "lyn/server" {
  interface Session {
    userId: string
  }

  interface Tables {
    users: User
    lists: List
    todos: Todo
    activity: Activity
  }
}
