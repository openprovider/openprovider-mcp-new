#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk';
import axios from 'axios';
// Environment variables for authentication
const USERNAME = process.env.OPENPROVIDER_USERNAME;
const PASSWORD = process.env.OPENPROVIDER_PASSWORD;
if (!USERNAME || !PASSWORD) {
    throw new Error('OPENPROVIDER_USERNAME and OPENPROVIDER_PASSWORD environment variables are required');
}
// Openprovider API base URL
const API_BASE_URL = 'https://api.openprovider.eu/v1beta';
class OpenproviderServer {
    constructor() {
        this.authToken = null;
        this.server = new Server({
            name: 'openprovider-server',
            version: '0.1.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.axiosInstance = axios.create({
            baseURL: API_BASE_URL,
            headers: {
                'Content-Type': 'application/json',
            },
        });
        this.setupToolHandlers();
        // Error handling
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    // Set up the tool handlers
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case 'login':
                    return this.handleLogin(request.params.arguments);
                case 'check_domain':
                    return this.handleCheckDomain(request.params.arguments);
                case 'register_domain':
                    return this.handleRegisterDomain(request.params.arguments);
                case 'list_domains':
                    return this.handleListDomains(request.params.arguments);
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    // Handle login request
    async handleLogin(args) {
        try {
            // Use environment variables if no credentials provided
            const username = args?.username || USERNAME;
            const password = args?.password || PASSWORD;
            const response = await this.axiosInstance.post('/auth/login', {
                username,
                password,
            });
            this.authToken = response.data.data.token;
            // Update axios instance with the auth token
            this.axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${this.authToken}`;
            return {
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
            };
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Authentication error: ${error.response?.data?.desc || error.message}`,
                        },
                    ],
                    isError: true,
                };
            }
            throw error;
        }
    }
    // Handle domain check request
    async handleCheckDomain(args) {
        try {
            // Ensure we have an auth token
            if (!this.authToken) {
                await this.handleLogin({});
            }
            if (!args.domains || !Array.isArray(args.domains)) {
                throw new McpError(ErrorCode.InvalidParams, 'Invalid domains parameter. Expected an array of domain objects.');
            }
            const requestData = {
                domains: args.domains,
                with_price: args.with_price !== false,
            };
            const response = await this.axiosInstance.post('/domains/check', requestData);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Domain check error: ${error.response?.data?.desc || error.message}`,
                        },
                    ],
                    isError: true,
                };
            }
            throw error;
        }
    }
    // Handle domain registration request
    async handleRegisterDomain(args) {
        try {
            // Ensure we have an auth token
            if (!this.authToken) {
                await this.handleLogin({});
            }
            if (!args.domain || !args.domain.name || !args.domain.extension) {
                throw new McpError(ErrorCode.InvalidParams, 'Invalid domain parameter. Expected an object with name and extension.');
            }
            if (!args.owner_handle) {
                throw new McpError(ErrorCode.InvalidParams, 'Owner handle is required for domain registration.');
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
            const response = await this.axiosInstance.post('/domains', requestData);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Domain registration error: ${error.response?.data?.desc || error.message}`,
                        },
                    ],
                    isError: true,
                };
            }
            throw error;
        }
    }
    // Handle list domains request
    async handleListDomains(args) {
        try {
            // Ensure we have an auth token
            if (!this.authToken) {
                await this.handleLogin({});
            }
            const params = {
                limit: args?.limit || 100,
                offset: args?.offset || 0,
            };
            if (args?.status) {
                params.status = args.status;
            }
            const response = await this.axiosInstance.get('/domains', { params });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `List domains error: ${error.response?.data?.desc || error.message}`,
                        },
                    ],
                    isError: true,
                };
            }
            throw error;
        }
    }
    // Run the server
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Openprovider MCP server running on stdio');
    }
}
const server = new OpenproviderServer();
server.run().catch(console.error);
