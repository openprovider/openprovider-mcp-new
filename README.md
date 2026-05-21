# Openprovider MCP Server

This is a Model Context Protocol (MCP) server for Openprovider.com that allows users to interact with their Openprovider account to perform various domain management actions.

## Features

The Openprovider MCP server provides the following tools:

- **login**: Authenticate with Openprovider and get a token
- **check_domain**: Check domain availability
- **register_domain**: Register a new domain
- **list_domains**: List domains in your Openprovider account
- **get_domain**: Get domain details
- **list_contacts**: List contacts in your Openprovider account
- **create_contact**: Create a new contact

## Installation

### 1. Install Node.js

Before installing the MCP server, make sure Node.js 20+ is installed. You can do this via Node Version Manager (nvm):

```bash
# Install nvm (if not already installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Reload shell
source ~/.bashrc

# Install Node.js 20
nvm install 20

# Set it as default
nvm use 20
```

### 2. Clone the Repository

```bash
git clone git@github.com:hichamdotpage/openprovider-mcp.git
cd openprovider-mcp
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Build the Project

```bash
npm run build
```

### 5. Test the Server

```bash
npm test
```

### 6. Install Globally (Optional)

You can install the MCP server globally to use it as a CLI tool:

```bash
# Install globally from the local directory
npm install -g .

# Or with yarn
yarn global add .

# Or with pnpm
pnpm add -g .
```

After installing globally, you can run the server from anywhere using:

```bash
openprovider-mcp
```

## Configuration

### Environment Variables

The server can be configured using environment variables. Create a `.env` file in the root directory based on the provided `.env.example`:

```
# Openprovider API Credentials
OPENPROVIDER_USERNAME=your_username
OPENPROVIDER_PASSWORD=your_password

# Debug mode (true/false)
DEBUG=false
```

## Integration with AI Assistants

### Cursor Integration

To use the Openprovider MCP server with Cursor, you need to add it to your Cursor MCP settings file located at:

```
~/.cursor/mcp/config.json
```

Add the following configuration:

```json
{
  "servers": {
    "openprovider": {
      "command": "node",
      "args": ["/path/to/openprovider-server/server.js"],
      "env": {
        "OPENPROVIDER_USERNAME": "your_username",
        "OPENPROVIDER_PASSWORD": "your_password",
        "DEBUG": "false"
      }
    }
  }
}
```

### Claude Integration

To use the Openprovider MCP server with Claude, you need to run the server and provide the endpoint to Claude. First, start the server:

```bash
node server.js --port 3000
```

Then, in Claude, you can connect to the MCP server using the following configuration:

```
MCP Server Configuration:
- Name: openprovider
- Endpoint: http://localhost:3000
- Authentication: None (authentication is handled by the server)
```

You can then use the MCP tools in Claude by using the following syntax:

```
<mcp name="openprovider" tool="check_domain">
{
  "domains": [
    {
      "name": "example",
      "extension": "com"
    }
  ],
  "with_price": true
}
</mcp>
```

## Usage

Once configured, you can use the Openprovider MCP server with Claude, ChatGPT, Cursor or any other platform that supports the Model Context Protocol.

### Example: Checking Domain Availability

```
<use_mcp_tool>
<server_name>openprovider</server_name>
<tool_name>check_domain</tool_name>
<arguments>
{
  "domains": [
    {
      "name": "example",
      "extension": "com"
    },
    {
      "name": "example",
      "extension": "org"
    }
  ],
  "with_price": true
}
</arguments>
</use_mcp_tool>
```

### Example: Registering a Domain

```
<use_mcp_tool>
<server_name>openprovider</server_name>
<tool_name>register_domain</tool_name>
<arguments>
{
  "domain": {
    "name": "example",
    "extension": "com"
  },
  "period": 1,
  "owner_handle": "ABC123",
  "name_servers": [
    {
      "name": "ns1.example.com"
    },
    {
      "name": "ns2.example.com"
    }
  ]
}
</arguments>
</use_mcp_tool>
```

## Documentation

Detailed documentation for all available tools can be found in the `docs` directory:

- [Tools Documentation](docs/tools.md): Detailed information about each tool, including input schemas, examples, and responses.
- [Troubleshooting Guide](docs/troubleshooting.md): Solutions to common issues you might encounter when using the Openprovider MCP server.

## Examples

The repository includes example scripts that demonstrate how to use the Openprovider MCP server:

### Domain Check Example

This example demonstrates how to check domain availability:

```
npm run example:check
```

### Domain Registration Example

This example demonstrates how to register a new domain:

```
npm run example:register
```

## Integration with Workflows

This MCP server can be used with workflow automation platforms like n8n to implement complex domain management workflows. The server exposes a standardized interface that can be accessed programmatically.

The examples in the `examples` directory show how to integrate with the MCP server programmatically using Node.js.

### n8n Workflow Example

An example n8n workflow is provided in the `examples/n8n-workflow.json` file. This workflow demonstrates how to:

1. Check domain availability
2. Display domain status and pricing
3. List contacts if the domain is available

To use this workflow:

1. Import the workflow JSON file into your n8n instance
2. Set up environment variables for `OPENPROVIDER_USERNAME` and `OPENPROVIDER_PASSWORD`
3. Make sure the Openprovider MCP server is running locally
4. Activate and run the workflow

## Contributing

We welcome contributions to the Openprovider MCP Server! Please see the [Contributing Guide](CONTRIBUTING.md) for more information on how to get started.

## About Openprovider

Openprovider is a wholesaler of Internet services and products with a unique platform from which you can find and manage all the products you need: Domains, new gTLDs, SSL certificates, licenses for Plesk, spam filters, and more!

For more information, visit [Openprovider.com](https://www.openprovider.com/).

## Repository

The source code for this project is available on GitHub:
```
git@github.com:hichamdotpage/openprovider-mcp.git
```

You can view the repository at [https://github.com/hichamdotpage/openprovider-mcp](https://github.com/hichamdotpage/openprovider-mcp)

## License

This project is licensed under the MIT License - see the LICENSE file for details.
