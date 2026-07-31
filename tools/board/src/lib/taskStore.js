export class TaskStore {
  async list() {
    throw new Error("TaskStore.list is not implemented");
  }

  async get(_id) {
    throw new Error("TaskStore.get is not implemented");
  }

  async create(_task) {
    throw new Error("TaskStore.create is not implemented");
  }

  async update(_id, _updates) {
    throw new Error("TaskStore.update is not implemented");
  }

  async move(_id, _status) {
    throw new Error("TaskStore.move is not implemented");
  }
}
