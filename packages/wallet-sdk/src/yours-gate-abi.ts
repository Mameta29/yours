// Generated from YoursPurchaseGate.sol by scripts/sync-contracts.mjs.
export const yoursPurchaseGateAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "m",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "jpyc",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "usdc",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "implementation",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "router",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "factory",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "e",
        "type": "address[7]",
        "internalType": "address[7]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "accountImplementation",
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
    "name": "active",
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
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "agentPermissions",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract AgentPermissionRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "cancelOrder",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "until",
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
    "name": "canonicalPolicyId",
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
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "domainDigest",
    "inputs": [
      {
        "name": "structHash",
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
    "name": "executePurchase",
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
      },
      {
        "name": "f",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.Funding",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "maxInput",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "outputJpyc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "adapter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "routeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "quoteDeadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "i",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.ExecutionIntent",
        "components": [
          {
            "name": "orderHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "paymentLeafHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "fundingLeafHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "paymentContext",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "fundingContext",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "r",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.RiskStamp",
        "components": [
          {
            "name": "intentHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "riskDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "rulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reasonMask",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "checkedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.PriceStamp",
        "components": [
          {
            "name": "orderHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "fairInputAtomic",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "sourceDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "observedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "h",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.HumanApproval",
        "components": [
          {
            "name": "approvalId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "intentHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "riskDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "identityBindingId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "overrideMask",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "authenticatedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "sig",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.Signatures",
        "components": [
          {
            "name": "merchant",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "agent",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "risk",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "price",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "human",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "route",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "result",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.PurchaseResult",
        "components": [
          {
            "name": "orderHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "actualInput",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reasons",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "periodJpycSpentAfter",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "periodInputSpentAfter",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "fundingAdapter",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract UniswapV3FundingAdapterV1"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "grant",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "version",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.GrantBinding",
        "components": [
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
            "name": "agent",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantChainHash",
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
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "inputToken",
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
    "name": "invalidateRevision",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
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
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "until",
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
    "name": "isApprovalUsed",
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
    "name": "isOrderCancelled",
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
    "name": "isRevisionInvalidated",
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
    "name": "manager",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IDelegationManagerV1"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "merchantNonce",
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
    "name": "ownerNonce",
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
    "name": "paidOrderHash",
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
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "policy",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.Policy",
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
            "name": "version",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "periodStart",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "periodSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "autoPerOrderJpyc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "autoPerPeriodJpyc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "merchantSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "assetLimitsHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "riskRulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "identityBindingId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "relayerSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "autoMaxPremiumBps",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "humanOverrideMask",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "merchantSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "riskSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "humanSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "priceSigner",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "registerPolicy",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.Policy",
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
            "name": "version",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "periodStart",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "periodSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "autoPerOrderJpyc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "autoPerPeriodJpyc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "merchantSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "assetLimitsHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "riskRulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "identityBindingId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "relayerSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "autoMaxPremiumBps",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "humanOverrideMask",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "merchantSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "riskSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "humanSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "priceSigner",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "shops",
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
        "name": "assets",
        "type": "tuple[]",
        "internalType": "struct IPurchaseGateV1.AssetLimit[]",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "autoPerOrder",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "autoPerPeriod",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "grants",
        "type": "tuple[]",
        "internalType": "struct IPurchaseGateV1.GrantBinding[]",
        "components": [
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
            "name": "agent",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantChainHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "senders",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "until",
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
    "name": "revokePolicy",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "until",
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
    "name": "settlementToken",
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
    "name": "spentInput",
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
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "spentJpyc",
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
    "type": "function",
    "name": "updatePolicy",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct IPurchaseGateV1.Policy",
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
            "name": "version",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "periodStart",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "periodSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "autoPerOrderJpyc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "autoPerPeriodJpyc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "merchantSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "assetLimitsHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "riskRulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "identityBindingId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "relayerSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "autoMaxPremiumBps",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "humanOverrideMask",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "merchantSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "riskSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "humanSigner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "priceSigner",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "shops",
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
        "name": "assets",
        "type": "tuple[]",
        "internalType": "struct IPurchaseGateV1.AssetLimit[]",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "autoPerOrder",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "autoPerPeriod",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "grants",
        "type": "tuple[]",
        "internalType": "struct IPurchaseGateV1.GrantBinding[]",
        "components": [
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
            "name": "agent",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantChainHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "senders",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "until",
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
    "name": "validator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract PurchaseValidatorV1"
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
    "name": "OrderCancellation",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyRegistered",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "policyId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "version",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyRevoked",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "policyId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PurchasePaid",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "orderHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "policyId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "policyVersion",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "periodIndex",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "payTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "settlementAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "inputToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "actualInput",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "approvalId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "reasonMask",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "riskDigest",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RevisionInvalidation",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "revisionId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AddressEmptyCode",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "AddressInsufficientBalance",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ApprovalAlreadyUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ApprovalDoesNotCover",
    "inputs": [
      {
        "name": "reasons",
        "type": "uint32",
        "internalType": "uint32"
      }
    ]
  },
  {
    "type": "error",
    "name": "DeadlineExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EvidenceUnavailable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FailedInnerCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FundingMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "HumanApprovalRequired",
    "inputs": [
      {
        "name": "reasons",
        "type": "uint32",
        "internalType": "uint32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidContext",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSignature",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "MathOverflowedMulDiv",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OrderAlreadyPaid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OrderCancelled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PaymentMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PeriodMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyInactive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyVersionMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RevisionInvalidated",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
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
  },
  {
    "type": "error",
    "name": "UnsupportedConfiguration",
    "inputs": []
  }
] as const;
