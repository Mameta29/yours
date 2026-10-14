// Generated from AgentPermissionRegistry.sol by scripts/sync-contracts.mjs.
export const agentPermissionRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "PERMISSION_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "REVOKE_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "active",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "configure",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct AgentPermissionRegistry.Permission",
        "components": [
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "policyId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "connectionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "revision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "agent",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "perOrder",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perPeriod",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "merchantsHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "allowed",
        "type": "tuple[]",
        "internalType": "struct IPurchaseGateV1.Merchant[]",
        "components": [
          {
            "name": "shopIdHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "payTo",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "connectionForAgent",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "consume",
    "inputs": [
      {
        "name": "o",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.PurchaseOrder",
        "components": [
          {
            "name": "orderId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "revisionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyVersion",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "periodIndex",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "agent",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "shopIdHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "payTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "settlementToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "settlementAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "basketCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "fundingHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "requirementsHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "reasons",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "domainDigest",
    "inputs": [
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "eip712Domain",
    "inputs": [],
    "outputs": [
      {
        "name": "fields",
        "type": "bytes1",
        "internalType": "bytes1"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "chainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "verifyingContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "extensions",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "gate",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nonces",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "permissions",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "policyId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "connectionId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "revision",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "validUntil",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "perOrder",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "perPeriod",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "merchantsHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revoke",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "connectionId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "spent",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "EIP712DomainChanged",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PermissionChanged",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "connectionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "revision",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PermissionRevoked",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "connectionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AgentInactive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidOwnerSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidPermission",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  }
] as const;
