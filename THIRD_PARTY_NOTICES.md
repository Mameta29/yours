# Source provenance

`packages/wallet-sdk` and `packages/contracts` originate from Mameta29's JPYC EC agent-commerce implementation. The selected files, source revision and extraction checksums are recorded in [docs/EXTRACTION.json](docs/EXTRACTION.json). They were extracted as an independent baseline and retain their source copyright and SPDX notices. Subsequent changes are recorded in this repository's commits.

The baseline contains neither the EC database nor its deployment configuration, signing keys or customer data. It does not represent a new audit of the contracts. Unit tests using mock tokens/managers are distinguished from integration tests against deployed protocols.

Dependencies retain their own licenses, including OpenZeppelin Contracts (MIT), viem (MIT), and MetaMask Smart Accounts Kit (MIT/Apache-2.0 as specified by the installed package). Consult each package's license for its terms.
