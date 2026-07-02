/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/gateway_deposit.json`.
 */
export type GatewayDeposit = {
  "address": "MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1",
  "metadata": {
    "name": "gatewayDeposit",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "burnDeposit",
      "docs": [
        "Burn `amount` wVIZ from the deposit ATA owned by the PDA derived from",
        "`viz_account`. This is the ONLY state-changing instruction: there is no",
        "path to transfer deposit tokens anywhere. Permissionless — burning cannot",
        "steal, and the value handoff (VIZ release) is M-of-N + F2-validated."
      ],
      "discriminator": [
        34,
        175,
        58,
        161,
        153,
        178,
        166,
        59
      ],
      "accounts": [
        {
          "name": "depositAuthority",
          "docs": [
            "PDA that owns the deposit ATA; off-curve, no private key. The \"deposit address\"."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "vizAccount"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "depositAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "depositAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "vizAccount",
          "type": "string"
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "accountNameTooLong",
      "msg": "viz_account must be ≤ 16 bytes (Graphene account name limit)"
    }
  ]
};
