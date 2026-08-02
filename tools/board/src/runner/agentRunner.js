export class AgentRunner {
  async start(_invocation) {
    throw new Error("AgentRunner.start is not implemented");
  }

  observe(_run) {
    throw new Error("AgentRunner.observe is not implemented");
  }

  kill(_run) {
    throw new Error("AgentRunner.kill is not implemented");
  }
}
