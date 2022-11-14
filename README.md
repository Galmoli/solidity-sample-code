# Solidity Sample Code

This repository **contains a contract and its respective tests** that I developed while working as a **Smart Contract Programmer**.

The functionality of the contract in this repository is to **maintain the correct collateralization of debt** issued by the platform. If a user issues debt and the collateral falls below the required health ratio, it will **liquidate the vault via an Uniswap Flash Loan**.

Please note that this contract won't compile out of the box because it requires dependencies that I'm not allowed to share.

This contract exposes **two main functions that anyone can call**: [checkLiquidableVaults](https://github.com/Galmoli/solidity-sample-code/blob/main/Contracts/StabilityPool.sol#L84) and [liquidateVault](https://github.com/Galmoli/solidity-sample-code/blob/main/Contracts/StabilityPool.sol#L115). The first one returns an array of the vaultIDs that are liquidable. The second is the function that should be called when liquidating a vault.

The contract also has 5 setter functions, but I think the focus of this document should be on how a user, without capital, can liquidate a vault (and profit from it) by calling the function **liquidateVault**.

![enter image description here](https://imgur.com/wqaHtd4.png)

The function **liquidateVault** is pretty simple, it checks if vaultID is liquidable, and if it can be liquidated, it starts the process by getting a *flash loan*. When calling *IUniswapV2Pair.swap()* if we send data via the calldata parameter, Uniswap will trigger the callback function. This callback function can be overridden and execute custom logic. The only requirement is that, at the end of the callback function, the tokens borrowed via flash loan + a **0.3% fee** must be returned to Uniswap. Otherwise, the transaction will revert.

In this contract, the [custom logic](https://github.com/Galmoli/solidity-sample-code/blob/main/Contracts/StabilityPool.sol#L169) is in charge of liquidating the vault, repay the *flash loan*, and finally, distribute rewards to all participants. In this case, the Treasury, the Reward Pool, and the Liquidator (caller).

This contract is tested using [Hardhat](https://hardhat.org/), [Chai](https://www.chaijs.com/), and [OpenZeppelin's Test helpers](https://docs.openzeppelin.com/test-helpers/0.5/).
