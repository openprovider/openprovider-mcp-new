#!/usr/bin/env node

import axios from 'axios';
import * as readline from 'readline';

// Environment variables for authentication
const USERNAME = process.env.OPENPROVIDER_USERNAME;
const PASSWORD = process.env.OPENPROVIDER_PASSWORD;

// Openprovider API base URL
const API_BASE_URL = 'https://api.openprovider.eu/v1beta';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Authentication token
let authToken: string | null = null;

// Create readline interface for stdio communication
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Handle incoming messages
rl.on('line', async (line) => {
  try {
    const request = JSON.parse(line);
    
    // Process the request
    const response = await handleRequest(request);
    
    // Send the response
    console.log(JSON.stringify(response));
  } catch (error) {
    console.error('Error processing request:', error);
    console.log(JSON.stringify({
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  }
});

// Handle requests
async function handleRequest(request: any) {
  switch (request.method) {
    case 'list_tools':
      return handleListTools();
    case 'call_tool':
      return handleCallTool(request.params);
    default:
      return {
        error: {
          code: 'method_not_found',
          message: `Unknown method: ${request.method}`,
        },
      };
  }
}

// Handle list_tools request
function handleListTools() {
  return {
    result: {
      tools: [
        {
          name: 'login',
          description: 'Authenticate with Openprovider and get a token',
          inputSchema: {
            type: 'object',
            properties: {
              username: {
                type: 'string',
                description: 'Openprovider username',
              },
              password: {
                type: 'string',
                description: 'Openprovider password',
              },
            },
            required: [],
          },
        },
        {
          name: 'check_domain',
          description: 'Check domain availability',
          inputSchema: {
            type: 'object',
            properties: {
              domains: {
                type: 'array',
                description: 'List of domains to check',
                items: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'Domain name without extension',
                    },
                    extension: {
                      type: 'string',
                      description: 'Domain extension (TLD)',
                    },
                  },
                  required: ['name', 'extension'],
                },
              },
              with_price: {
                type: 'boolean',
                description: 'Include price information',
                default: true,
              },
            },
            required: ['domains'],
          },
        },
        {
          name: 'register_domain',
          description: 'Register a new domain',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Domain name without extension',
                  },
                  extension: {
                    type: 'string',
                    description: 'Domain extension (TLD)',
                  },
                },
                required: ['name', 'extension'],
              },
              period: {
                type: 'number',
                description: 'Registration period in years',
                default: 1,
              },
              owner_handle: {
                type: 'string',
                description: 'Owner contact handle',
              },
              admin_handle: {
                type: 'string',
                description: 'Administrative contact handle',
              },
              tech_handle: {
                type: 'string',
                description: 'Technical contact handle',
              },
              billing_handle: {
                type: 'string',
                description: 'Billing contact handle',
              },
              name_servers: {
                type: 'array',
                description: 'List of nameservers',
                items: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'Nameserver hostname',
                    },
                    ip: {
                      type: 'string',
                      description: 'Nameserver IP address',
                    },
                    ip6: {
                      type: 'string',
                      description: 'Nameserver IPv6 address',
                    },
                  },
                  required: ['name'],
                },
              },
              ns_group: {
                type: 'string',
                description: 'Nameserver group',
              },
              use_domicile: {
                type: 'boolean',
                description: 'Use domicile service',
                default: false,
              },
              is_private_whois_enabled: {
                type: 'boolean',
                description: 'Enable private WHOIS',
                default: false,
              },
              is_dnssec_enabled: {
                type: 'boolean',
                description: 'Enable DNSSEC',
                default: false,
              },
              autorenew: {
                type: 'string',
                description: 'Auto-renewal setting (on, off, default)',
                default: 'default',
              },
            },
            required: ['domain', 'period', 'owner_handle'],
          },
        },
        {
          name: 'list_domains',
          description: 'List domains in your Openprovider account',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of domains to return',
                default: 100,
              },
              offset: {
                type: 'number',
                description: 'Offset for pagination',
                default: 0,
              },
              status: {
                type: 'string',
                description: 'Filter by domain status',
              },
            },
            required: [],
          },
        },
      ],
    },
  };
}

// Handle call_tool request
async function handleCallTool(params: any) {
  try {
    switch (params.name) {
      case 'login':
        return await handleLogin(params.arguments || {});
      case 'check_domain':
        return await handleCheckDomain(params.arguments || {});
      case 'register_domain':
        return await handleRegisterDomain(params.arguments || {});
      case 'list_domains':
        return await handleListDomains(params.arguments || {});
      default:
        return {
          error: {
            code: 'method_not_found',
            message: `Unknown tool: ${params.name}`,
          },
        };
    }
  } catch (error) {
    return {
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// Handle login
async function handleLogin(args: any) {
  try {
    // Use environment variables if no credentials provided
    const username = args.username || USERNAME;
    const password = args.password || PASSWORD;

    if (!username || !password) {
      throw new Error('Username and password are required');
    }

    const response = await api.post('/auth/login', {
      username,
      password,
    });

    authToken = response.data.data.token;
    
    // Update axios instance with the auth token
    api.defaults.headers.common['Authorization'] = `Bearer ${authToken}`;

    return {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Successfully authenticated with Openprovider',
              reseller_id: response.data.data.reseller_id,
            }, null, 2),
          },
        ],
      },
    };
  } catch (error) {
    let errorMessage = 'Authentication error';
    
    if (axios.isAxiosError(error) && error.response) {
      errorMessage = `Authentication error: ${error.response.data?.desc || error.message}`;
    } else if (error instanceof Error) {
      errorMessage = `Authentication error: ${error.message}`;
    }
    
    return {
      error: {
        code: 'authentication_error',
        message: errorMessage,
      },
    };
  }
}

// Handle domain check
async function handleCheckDomain(args: any) {
  try {
    // Ensure we have an auth token
    if (!authToken) {
      await handleLogin({});
    }

    if (!args.domains || !Array.isArray(args.domains)) {
      throw new Error('Invalid domains parameter. Expected an array of domain objects.');
    }

    const requestData = {
      domains: args.domains,
      with_price: args.with_price !== false,
    };

    const response = await api.post('/domains/check', requestData);

    return {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      },
    };
  } catch (error) {
    let errorMessage = 'Domain check error';
    
    if (axios.isAxiosError(error) && error.response) {
      errorMessage = `Domain check error: ${error.response.data?.desc || error.message}`;
    } else if (error instanceof Error) {
      errorMessage = `Domain check error: ${error.message}`;
    }
    
    return {
      error: {
        code: 'domain_check_error',
        message: errorMessage,
      },
    };
  }
}

// Handle domain registration
async function handleRegisterDomain(args: any) {
  try {
    // Ensure we have an auth token
    if (!authToken) {
      await handleLogin({});
    }

    if (!args.domain || !args.domain.name || !args.domain.extension) {
      throw new Error('Invalid domain parameter. Expected an object with name and extension.');
    }

    if (!args.owner_handle) {
      throw new Error('Owner handle is required for domain registration.');
    }

    const requestData = {
      domain: args.domain,
      period: args.period || 1,
      owner_handle: args.owner_handle,
      admin_handle: args.admin_handle,
      tech_handle: args.tech_handle,
      billing_handle: args.billing_handle,
      name_servers: args.name_servers,
      ns_group: args.ns_group,
      use_domicile: args.use_domicile,
      is_private_whois_enabled: args.is_private_whois_enabled,
      is_dnssec_enabled: args.is_dnssec_enabled,
      autorenew: args.autorenew,
    };

    const response = await api.post('/domains', requestData);

    return {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      },
    };
  } catch (error) {
    let errorMessage = 'Domain registration error';
    
    if (axios.isAxiosError(error) && error.response) {
      errorMessage = `Domain registration error: ${error.response.data?.desc || error.message}`;
    } else if (error instanceof Error) {
      errorMessage = `Domain registration error: ${error.message}`;
    }
    
    return {
      error: {
        code: 'domain_registration_error',
        message: errorMessage,
      },
    };
  }
}

// Handle list domains
async function handleListDomains(args: any) {
  try {
    // Ensure we have an auth token
    if (!authToken) {
      await handleLogin({});
    }

    const params: Record<string, any> = {
      limit: args?.limit || 100,
      offset: args?.offset || 0,
    };

    if (args?.status) {
      params.status = args.status;
    }

    const response = await api.get('/domains', { params });

    return {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      },
    };
  } catch (error) {
    let errorMessage = 'List domains error';
    
    if (axios.isAxiosError(error) && error.response) {
      errorMessage = `List domains error: ${error.response.data?.desc || error.message}`;
    } else if (error instanceof Error) {
      errorMessage = `List domains error: ${error.message}`;
    }
    
    return {
      error: {
        code: 'list_domains_error',
        message: errorMessage,
      },
    };
  }
}

// Handle process termination
process.on('SIGINT', () => {
  rl.close();
  process.exit(0);
});

console.error('Openprovider MCP server running on stdio');