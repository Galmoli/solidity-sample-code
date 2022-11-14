const hre = require("hardhat");
const { expect } = require("chai");
const { BN } = require("@openzeppelin/test-helpers");
const { ZERO_ADDRESS } = require("@openzeppelin/test-helpers/src/constants");

const MAX_ALLOWANCE = hre.ethers.constants.MaxUint256;
const ONE_MILLION_ETHER = hre.ethers.utils.parseEther("1000000");
const HUNDRED_THOUSAND_ETHER = hre.ethers.utils.parseEther("100000");
const EIGHTY_THOUSAND_ETHER = hre.ethers.utils.parseEther("80000");
const TEN_THOUSAND_ETHER = hre.ethers.utils.parseEther("10000");
const HUNDRED_ETHER = hre.ethers.utils.parseEther("100");
const ONE_ETHER = hre.ethers.utils.parseEther("1");
const ETH_ORACLE_PRICE_1000 = 100000000000;
const ETH_ORACLE_PRICE_900 = 90000000000;
const USER_VAULT_ID = 1;
const VAULT_CDR = 120;
const UNIFACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const UNIROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

/*
    Vault stats               StabilityPool stats                  User stats
    -----------               -------------------                  -----------

    ETH PRICE = $1000         CallFee = 2% of Profit               INITIAL DEPOSIT = 100 WETH
    VAULT CDR = 120%          TreasuryFee = 20% of Profit          INITIAL BORROW = $80K
    DEBT CEILING = $1M        FlashLoanFee = 0.3%                  INITIAL CDR = 125%
    OPEN FEE = 0%
    CLOSE FEE = 0%
    MAX DEBT = $100K
    LIQUIDATION PENALTY = 10%
    LIQUIDATION BITE = 50%
*/

/* -- TEST LP SETUP -- 

    0. Airdrop 100 WETH to the user
    1. Airdrop 1M USDC and 1M MUSD (mStable) to the Market Maker
    2. Deploy a USDC - MUSD LP
    3. Add 1M USDC & 1M MUSD to the LP 
    4. Airdrop 10K WETH and 9M USDC to the Market Maker (ETH price will be 900 on the LP)
    5. Deploy a WETH - USDC LP
    6. Add 10K WETH & 9M USDC to the LP

*/

describe("Contract: StabilityPool", () => {
    before(async() =>{
        accounts = await hre.ethers.getSigners();
        deployer = accounts[0];
        user = accounts[1];
        user2 = accounts[2];
        user3 = accounts[3];
        marketMaker = accounts[4];
        treasury = accounts[5];
        rewardPool = accounts[6];
        caller = accounts[7];
        });
    beforeEach(async()=>{
        MockV3Aggregator = await hre.ethers.getContractFactory("MockV3Aggregator", deployer);
        mockV3Aggregator = await MockV3Aggregator.deploy(8, ETH_ORACLE_PRICE_1000);

        uniswapRouter = await hre.ethers.getContractAt("IUniswapV2Router02", UNIROUTER);

        WETHMockERC20 = await hre.ethers.getContractFactory("MockERC20");
        wethMockERC20 = await WETHMockERC20.deploy("Wrapped Ether", "WETH", user.address, 0);

        MUSDMockERC20 = await hre.ethers.getContractFactory("MockERC20");
        musdMockERC20 = await MUSDMockERC20.deploy("mUSD", "mUSD", user.address, 0);

        USDCMockERC20 = await hre.ethers.getContractFactory("MockERC20");
        usdcMockERC20 = await USDCMockERC20.deploy("USDC", "USDC", user.address, 0);

        FixedQiVault = await hre.ethers.getContractFactory("FixedQiVault", deployer);
        fixedQiVault = await FixedQiVault.deploy(mockV3Aggregator.address, VAULT_CDR, "mWETH", "mWETH", musdMockERC20.address, wethMockERC20.address, "");

        StabilityPool = await hre.ethers.getContractFactory("$StabilityPool", deployer);
        stabilityPool = await StabilityPool.deploy(UNIFACTORY, UNIROUTER, musdMockERC20.address, usdcMockERC20.address);

        await fixedQiVault.connect(deployer).setMaxDebt(HUNDRED_THOUSAND_ETHER);
        await fixedQiVault.connect(deployer).setStabilityPool(stabilityPool.address);
        await musdMockERC20.mint(fixedQiVault.address, ONE_MILLION_ETHER);
        await musdMockERC20.approveInternal(user.address, fixedQiVault.address, MAX_ALLOWANCE);

        await stabilityPool.connect(deployer).setTreasury(treasury.address);
        await stabilityPool.connect(deployer).setRewardPool(rewardPool.address);
        await stabilityPool.connect(deployer).setFlashLoanFee(30);
        await stabilityPool.connect(deployer).setDistributionFees(200, 2000);
        await stabilityPool.connect(deployer).setUniRouterPath(fixedQiVault.address, [wethMockERC20.address, usdcMockERC20.address, musdMockERC20.address]);

        await wethMockERC20.mint(user.address, HUNDRED_ETHER);
        await wethMockERC20.approveInternal(user.address, fixedQiVault.address, MAX_ALLOWANCE);

        await fixedQiVault.connect(user).createVault();
        await fixedQiVault.connect(user).depositCollateral(USER_VAULT_ID, HUNDRED_ETHER);
        await fixedQiVault.connect(user).borrowToken(USER_VAULT_ID, EIGHTY_THOUSAND_ETHER);

        await usdcMockERC20.mint(marketMaker.address, hre.ethers.utils.parseEther("10000000"));
        await musdMockERC20.mint(marketMaker.address, hre.ethers.utils.parseEther("1000000"));
        await wethMockERC20.mint(marketMaker.address, hre.ethers.utils.parseEther("10000"));

        await usdcMockERC20.approveInternal(marketMaker.address, uniswapRouter.address, MAX_ALLOWANCE);
        await musdMockERC20.approveInternal(marketMaker.address, uniswapRouter.address, MAX_ALLOWANCE);
        await wethMockERC20.approveInternal(marketMaker.address, uniswapRouter.address, MAX_ALLOWANCE);

        const blockNumBefore = await ethers.provider.getBlockNumber();
        const blockBefore = await ethers.provider.getBlock(blockNumBefore);

        await uniswapRouter.connect(marketMaker).addLiquidity(
            usdcMockERC20.address, 
            musdMockERC20.address,
            ONE_MILLION_ETHER,
            ONE_MILLION_ETHER,
            ONE_MILLION_ETHER,
            ONE_MILLION_ETHER,
            marketMaker.address,
            blockBefore.timestamp + 10);

        await uniswapRouter.connect(marketMaker).addLiquidity(
            wethMockERC20.address, 
            usdcMockERC20.address,
            TEN_THOUSAND_ETHER,
            ONE_MILLION_ETHER.mul(9),
            TEN_THOUSAND_ETHER,
            ONE_MILLION_ETHER.mul(9),
            marketMaker.address,
            blockBefore.timestamp + 10);
    });
    it("Set Treasury Address", async() => {
        await expect(stabilityPool.connect(deployer).setTreasury(ZERO_ADDRESS)).to.be.revertedWith("Treasury address can't be 0");
        await expect(stabilityPool.connect(user).setTreasury(user.address)).to.be.revertedWith("Ownable: caller is not the owner");
        expect(await stabilityPool.treasury()).to.eq(treasury.address);
    });
    it("Set Reward Pool Address", async() => {
        await expect(stabilityPool.connect(deployer).setRewardPool(ZERO_ADDRESS)).to.be.revertedWith("Reward Pool address can't be 0");
        await expect(stabilityPool.connect(user).setRewardPool(user.address)).to.be.revertedWith("Ownable: caller is not the owner");
        expect(await stabilityPool.rewardPool()).to.eq(rewardPool.address);
    });
    it("Set Flash Loan Fee", async() => {
        await expect(stabilityPool.connect(deployer).setFlashLoanFee(0)).to.be.revertedWith("Flash Loan Fee can't be 0");
        await expect(stabilityPool.connect(user).setFlashLoanFee(30)).to.be.revertedWith("Ownable: caller is not the owner");
        expect(await stabilityPool.flashLoanFee()).to.eq(30);
    });
    it("Set Distribution Fees", async() => {
        await expect(stabilityPool.connect(deployer).setDistributionFees(3000, 2000)).to.be.revertedWith("Fees too high");
        await expect(stabilityPool.connect(user).setDistributionFees(200, 2000)).to.be.revertedWith("Ownable: caller is not the owner");
        expect(await stabilityPool.callFee()).to.eq(200);
        expect(await stabilityPool.treasuryFee()).to.eq(2000);
    });
    it("Set Uniswap Path", async() => {
        await expect(stabilityPool.connect(user).setUniRouterPath(fixedQiVault.address, [wethMockERC20.address, usdcMockERC20.address, musdMockERC20.address])).to.be.revertedWith("Ownable: caller is not the owner");
        expect(await stabilityPool.uniRouterPath(fixedQiVault.address, 0)).to.eq(wethMockERC20.address);
        expect(await stabilityPool.uniRouterPath(fixedQiVault.address, 1)).to.eq(usdcMockERC20.address);
        expect(await stabilityPool.uniRouterPath(fixedQiVault.address, 2)).to.eq(musdMockERC20.address);
    });
    it("$_isLiquidable", async() => {
        await wethMockERC20.mint(user2.address, HUNDRED_ETHER);
        await wethMockERC20.approveInternal(user2.address, fixedQiVault.address, MAX_ALLOWANCE);
        await fixedQiVault.connect(user2).createVault();
        await fixedQiVault.connect(user2).depositCollateral(2, HUNDRED_ETHER);
        await fixedQiVault.connect(user2).borrowToken(2, EIGHTY_THOUSAND_ETHER.div(2));

        await mockV3Aggregator.updateAnswer(ETH_ORACLE_PRICE_900);

        expect(await stabilityPool.$_isLiquidable(fixedQiVault.address, 1)).to.be.true;
        expect(await stabilityPool.$_isLiquidable(fixedQiVault.address, 2)).to.be.false;
        expect(await stabilityPool.$_isLiquidable(fixedQiVault.address, 3)).to.be.false;
    });
    it("$_calculateDistribution", async() => {
        let distribution = await stabilityPool.$_calculateDistribution(HUNDRED_ETHER);
        let cFee = hre.ethers.utils.formatEther(distribution[0]);
        let tFee = hre.ethers.utils.formatEther(distribution[1]);
        let rpFee = hre.ethers.utils.formatEther(distribution[2]);

        expect(parseFloat(cFee)).to.eq(2);
        expect(parseFloat(tFee)).to.eq(20);
        expect(parseFloat(rpFee)).to.eq(78);
    });
    it("$_calculateAmountInMax", async() => {
        let amountInMax = await stabilityPool.$_calculateAmountInMax(fixedQiVault.address, HUNDRED_THOUSAND_ETHER.div(2), 200);
        amountInMax = hre.ethers.utils.formatEther(amountInMax);

        let noSlippageAmounts = await uniswapRouter.getAmountsIn(HUNDRED_THOUSAND_ETHER.div(2), [wethMockERC20.address, usdcMockERC20.address, musdMockERC20.address]);
        let noSlippageAmount = hre.ethers.utils.formatEther(noSlippageAmounts[0])

        expect(parseFloat(amountInMax)).to.eq(parseFloat(noSlippageAmount) * 1.02);
    });
    it("Check Liquidable Vaults", async() => {
        // user1 & user2 will be liquidable, user3 won't be
        await wethMockERC20.mint(user2.address, HUNDRED_ETHER);
        await wethMockERC20.approveInternal(user2.address, fixedQiVault.address, MAX_ALLOWANCE);
        await fixedQiVault.connect(user2).createVault();
        await fixedQiVault.connect(user2).depositCollateral(2, HUNDRED_ETHER);
        await fixedQiVault.connect(user2).borrowToken(2, EIGHTY_THOUSAND_ETHER);

        await wethMockERC20.mint(user3.address, HUNDRED_ETHER);
        await wethMockERC20.approveInternal(user3.address, fixedQiVault.address, MAX_ALLOWANCE);
        await fixedQiVault.connect(user3).createVault();
        await fixedQiVault.connect(user3).depositCollateral(3, HUNDRED_ETHER);
        await fixedQiVault.connect(user3).borrowToken(3, EIGHTY_THOUSAND_ETHER.div(2));

        await mockV3Aggregator.updateAnswer(ETH_ORACLE_PRICE_900);

        liquidableVaults = await stabilityPool.connect(caller).checkLiquidableVaults(fixedQiVault.address);
        expect(liquidableVaults.length).to.eq(2);
        expect(liquidableVaults[0]).to.eq(1);
        expect(liquidableVaults[1]).to.eq(2);
    });
});