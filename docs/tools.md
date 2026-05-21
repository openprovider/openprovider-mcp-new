# Openprovider MCP Server Tools

This document provides detailed information about each tool available in the Openprovider MCP server.

## Authentication

### login

Authenticate with Openprovider and get a token.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "username": {
      "type": "string",
      "description": "Openprovider username"
    },
    "password": {
      "type": "string",
      "description": "Openprovider password"
    }
  },
  "required": []
}
```

**Example:**
```json
{
  "username": "your_username",
  "password": "your_password"
}
```

**Response:**
```json
{
  "token": "6f6d86377bc******feb75cea76d8e8b",
  "reseller_id": 100001
}
```

## Domain Management

### check_domain

Check domain availability and optionally retrieve the registration price. Multiple domains can be searched in parallel.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "domains": {
      "type": "array",
      "description": "List of domains to check",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Domain name without extension"
          },
          "extension": {
            "type": "string",
            "description": "Domain extension (TLD)"
          }
        },
        "required": [
          "name",
          "extension"
        ]
      }
    },
    "with_price": {
      "type": "boolean",
      "description": "Include price information",
      "default": true
    }
  },
  "required": [
    "domains"
  ]
}
```

**Example:**
```json
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
```

**Response:**
```json
{
  "results": [
    {
      "domain": "example.com",
      "price": {
        "product": {
          "currency": "USD",
          "price": 8.57
        },
        "reseller": {
          "currency": "EUR",
          "price": 7.53
        }
      },
      "status": "in use"
    },
    {
      "domain": "example.org",
      "price": {
        "product": {
          "currency": "USD",
          "price": 9.57
        },
        "reseller": {
          "currency": "EUR",
          "price": 8.53
        }
      },
      "status": "free"
    }
  ]
}
```

### register_domain

Register a new domain.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Domain name without extension"
        },
        "extension": {
          "type": "string",
          "description": "Domain extension (TLD)"
        }
      },
      "required": [
        "name",
        "extension"
      ]
    },
    "period": {
      "type": "number",
      "description": "Registration period in years",
      "default": 1
    },
    "owner_handle": {
      "type": "string",
      "description": "Owner contact handle"
    },
    "admin_handle": {
      "type": "string",
      "description": "Administrative contact handle"
    },
    "tech_handle": {
      "type": "string",
      "description": "Technical contact handle"
    },
    "billing_handle": {
      "type": "string",
      "description": "Billing contact handle"
    },
    "name_servers": {
      "type": "array",
      "description": "List of nameservers",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Nameserver hostname"
          },
          "ip": {
            "type": "string",
            "description": "Nameserver IP address"
          },
          "ip6": {
            "type": "string",
            "description": "Nameserver IPv6 address"
          }
        },
        "required": [
          "name"
        ]
      }
    },
    "ns_group": {
      "type": "string",
      "description": "Nameserver group"
    },
    "use_domicile": {
      "type": "boolean",
      "description": "Use domicile service",
      "default": false
    },
    "is_private_whois_enabled": {
      "type": "boolean",
      "description": "Enable private WHOIS",
      "default": false
    },
    "is_dnssec_enabled": {
      "type": "boolean",
      "description": "Enable DNSSEC",
      "default": false
    },
    "autorenew": {
      "type": "string",
      "description": "Auto-renewal setting (on, off, default)",
      "default": "default"
    }
  },
  "required": [
    "domain",
    "period",
    "owner_handle"
  ]
}
```

**Example:**
```json
{
  "domain": {
    "name": "example",
    "extension": "org"
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
  ],
  "autorenew": "default"
}
```

**Response:**
```json
{
  "id": 12345,
  "status": "active",
  "domain": "example.org",
  "expiration_date": "2026-01-01"
}
```

### list_domains

List domains in your Openprovider account.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "description": "Maximum number of domains to return",
      "default": 100
    },
    "offset": {
      "type": "number",
      "description": "Offset for pagination",
      "default": 0
    },
    "status": {
      "type": "string",
      "description": "Filter by domain status"
    }
  },
  "required": []
}
```

**Example:**
```json
{
  "limit": 10,
  "offset": 0,
  "status": "active"
}
```

**Response:**
```json
{
  "results": [
    {
      "id": 12345,
      "domain": "example.org",
      "status": "active",
      "expiration_date": "2026-01-01"
    },
    {
      "id": 12346,
      "domain": "example.net",
      "status": "active",
      "expiration_date": "2026-02-01"
    }
  ],
  "total": 2
}
```

### get_domain

Get domain details.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "number",
      "description": "Domain ID"
    }
  },
  "required": [
    "id"
  ]
}
```

**Example:**
```json
{
  "id": 12345
}
```

**Response:**
```json
{
  "id": 12345,
  "domain": "example.org",
  "status": "active",
  "expiration_date": "2026-01-01",
  "owner_handle": "ABC123",
  "admin_handle": "ABC123",
  "tech_handle": "ABC123",
  "billing_handle": "ABC123",
  "name_servers": [
    {
      "name": "ns1.example.com",
      "ip": "192.0.2.1"
    },
    {
      "name": "ns2.example.com",
      "ip": "192.0.2.2"
    }
  ],
  "is_private_whois_enabled": false,
  "is_dnssec_enabled": false,
  "autorenew": "default"
}
```

## Contact Management

### list_contacts

List contacts in your Openprovider account.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "description": "Maximum number of contacts to return",
      "default": 100
    },
    "offset": {
      "type": "number",
      "description": "Offset for pagination",
      "default": 0
    }
  },
  "required": []
}
```

**Example:**
```json
{
  "limit": 10,
  "offset": 0
}
```

**Response:**
```json
{
  "results": [
    {
      "handle": "ABC123",
      "name": {
        "first_name": "John",
        "last_name": "Doe"
      },
      "email": "john.doe@example.com",
      "phone": {
        "country_code": "1",
        "area_code": "555",
        "subscriber_number": "1234567"
      },
      "address": {
        "street": "123 Main St",
        "number": "1",
        "city": "Anytown",
        "zipcode": "12345",
        "country": "US"
      }
    }
  ],
  "total": 1
}
```

### create_contact

Create a new contact.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "description": "Contact email address"
    },
    "name": {
      "type": "object",
      "description": "Contact name",
      "properties": {
        "first_name": {
          "type": "string",
          "description": "First name"
        },
        "last_name": {
          "type": "string",
          "description": "Last name"
        }
      },
      "required": [
        "first_name",
        "last_name"
      ]
    },
    "phone": {
      "type": "object",
      "description": "Contact phone",
      "properties": {
        "country_code": {
          "type": "string",
          "description": "Country code"
        },
        "area_code": {
          "type": "string",
          "description": "Area code"
        },
        "subscriber_number": {
          "type": "string",
          "description": "Subscriber number"
        }
      },
      "required": [
        "country_code",
        "subscriber_number"
      ]
    },
    "address": {
      "type": "object",
      "description": "Contact address",
      "properties": {
        "street": {
          "type": "string",
          "description": "Street"
        },
        "number": {
          "type": "string",
          "description": "House number"
        },
        "city": {
          "type": "string",
          "description": "City"
        },
        "zipcode": {
          "type": "string",
          "description": "Zip code"
        },
        "country": {
          "type": "string",
          "description": "Country code (2 letters)"
        }
      },
      "required": [
        "street",
        "city",
        "zipcode",
        "country"
      ]
    },
    "company_name": {
      "type": "string",
      "description": "Company name"
    }
  },
  "required": [
    "email",
    "name",
    "phone",
    "address"
  ]
}
```

**Example:**
```json
{
  "email": "jane.doe@example.com",
  "name": {
    "first_name": "Jane",
    "last_name": "Doe"
  },
  "phone": {
    "country_code": "1",
    "area_code": "555",
    "subscriber_number": "7654321"
  },
  "address": {
    "street": "456 Oak St",
    "number": "2",
    "city": "Othertown",
    "zipcode": "54321",
    "country": "US"
  },
  "company_name": "Example Corp"
}
```

**Response:**
```json
{
  "handle": "DEF456",
  "name": {
    "first_name": "Jane",
    "last_name": "Doe"
  },
  "email": "jane.doe@example.com",
  "phone": {
    "country_code": "1",
    "area_code": "555",
    "subscriber_number": "7654321"
  },
  "address": {
    "street": "456 Oak St",
    "number": "2",
    "city": "Othertown",
    "zipcode": "54321",
    "country": "US"
  },
  "company_name": "Example Corp"
}