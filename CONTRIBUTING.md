# Contributing to Openprovider MCP Server

Thank you for your interest in contributing to the Openprovider MCP Server! This document provides guidelines and instructions for contributing to this project.

## Code of Conduct

Please be respectful and considerate of others when contributing to this project. We aim to foster an inclusive and welcoming community.

## How to Contribute

There are many ways to contribute to this project:

1. **Reporting Bugs**: If you find a bug, please create an issue with a detailed description of the problem, steps to reproduce it, and your environment details.

2. **Suggesting Enhancements**: If you have ideas for new features or improvements, please create an issue describing your suggestion.

3. **Code Contributions**: If you want to contribute code, please follow the process below.

## Development Process

1. **Fork the Repository**: Start by forking the repository to your GitHub account.

2. **Clone Your Fork**: Clone your fork to your local machine.
   ```
   git clone git@github.com:your-username/openprovider-mcp.git
   cd openprovider-mcp
   ```

3. **Install Dependencies**: Install the project dependencies.
   ```
   npm install
   ```

4. **Create a Branch**: Create a new branch for your changes.
   ```
   git checkout -b feature/your-feature-name
   ```

5. **Make Your Changes**: Implement your changes, following the coding standards and guidelines.

6. **Test Your Changes**: Make sure your changes work as expected and don't break existing functionality.
   ```
   npm test
   ```

7. **Commit Your Changes**: Commit your changes with a clear and descriptive commit message.
   ```
   git commit -m "Add feature: your feature description"
   ```

8. **Push to Your Fork**: Push your changes to your fork on GitHub.
   ```
   git push origin feature/your-feature-name
   ```

9. **Create a Pull Request**: Create a pull request from your fork to the main repository.

## Coding Standards

Please follow these coding standards when contributing to the project:

1. **TypeScript**: Use TypeScript for all new code.
2. **Formatting**: Use consistent formatting. We recommend using Prettier.
3. **Comments**: Add comments to explain complex logic or non-obvious behavior.
4. **Error Handling**: Properly handle errors and edge cases.
5. **Testing**: Add tests for new functionality.

## Adding New Tools

If you want to add a new tool to the MCP server, follow these steps:

1. **Define the Tool**: Create a new method in the `MCPServer` class in `src/server.ts`.

2. **Define the Input Schema**: Define the input schema for the tool using JSON Schema.

3. **Implement the Tool**: Implement the tool functionality, making API calls to Openprovider as needed.

4. **Register the Tool**: Register the tool in the `registerTools` method.

5. **Document the Tool**: Add documentation for the tool in `docs/tools.md`.

6. **Test the Tool**: Add tests for the tool.

Example of adding a new tool:

```typescript
// Define the tool method
private async renewDomain(args: any): Promise<any> {
  // Validate the input
  if (!args.domain_id) {
    throw new Error('Domain ID is required');
  }

  // Make the API call
  const response = await this.makeRequest('POST', '/domains/renew', {
    id: args.domain_id,
    period: args.period || 1
  });

  return response.data;
}

// Register the tool
private registerTools(): void {
  // ... existing tools ...

  // Register the new tool
  this.tools.set('renew_domain', {
    handler: this.renewDomain.bind(this),
    description: 'Renew a domain registration',
    inputSchema: {
      type: 'object',
      properties: {
        domain_id: {
          type: 'number',
          description: 'Domain ID'
        },
        period: {
          type: 'number',
          description: 'Renewal period in years',
          default: 1
        }
      },
      required: ['domain_id']
    }
  });
}
```

## Pull Request Process

1. **Update Documentation**: Update the documentation to reflect your changes.
2. **Add Tests**: Add tests for your changes if applicable.
3. **Update the README**: Update the README.md if necessary.
4. **Create a Pull Request**: Create a pull request with a clear description of your changes.

## License

By contributing to this project, you agree that your contributions will be licensed under the project's license.

## Questions?

If you have any questions or need help, please create an issue or contact the project maintainers.

Thank you for contributing to the Openprovider MCP Server!