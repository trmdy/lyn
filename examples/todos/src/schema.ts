export interface List {
  id: string
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
  message: string
  createdAt: Date
}

declare module "lyn/server" {
  interface Tables {
    lists: List
    todos: Todo
    activity: Activity
  }
}
