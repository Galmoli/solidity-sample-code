// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IFixedVault.sol";
import "../interfaces/UniswapV2/IUniswapV2Callee.sol";
import "../interfaces/UniswapV2/IUniswapV2Factory.sol";
import "../interfaces/UniswapV2/IUniswapV2Pair.sol";
import "../interfaces/UniswapV2/IUniswapV2Router02.sol";

contract StabilityPool is IUniswapV2Callee, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant TEN_THOUSAND = 10000;

    address private uniswapFactory;
    address private uniswapRouter;
    address private mStable;
    address private usdc;

    //Fees are base 100. 1% = 100
    uint256 public callFee;
    uint256 public flashLoanFee;
    uint256 public treasuryFee;

    mapping(address => address[]) public uniRouterPath;

    address public treasury;
    address public rewardPool;

    constructor(
        address _uniswapV2Factory,
        address _uniswapV2Router,
        address _mStable,
        address _usdc
        ){
        uniswapFactory = _uniswapV2Factory;
        uniswapRouter = _uniswapV2Router;
        mStable = _mStable;
        usdc = _usdc;
    }

    /// @param _treasury New Treasury address
    /// @notice Sets the treasury address
    function setTreasury(address _treasury) external onlyOwner() {
        require(_treasury != address(0), "Treasury address can't be 0");
        treasury = _treasury;
    }

    /// @param _rewardPool New Reward Pool address
    /// @notice Sets the Reward Pool address
    function setRewardPool(address _rewardPool) external onlyOwner() {
        require(_rewardPool != address(0), "Reward Pool address can't be 0");
        rewardPool = _rewardPool;
    }

    /// @param _flashLoanFee New Flash Loan Fee
    /// @notice Sets flashLoanFee
    function setFlashLoanFee(uint256 _flashLoanFee) external onlyOwner() {
        require(_flashLoanFee != 0, "Flash Loan Fee can't be 0");
        flashLoanFee = _flashLoanFee;
    }

    /// @param _callFee New Call Fee
    /// @param _treasuryFee New Treasury Fee
    /// @notice Sets the distribution share of profits when liquidating a vault
    function setDistributionFees(uint256 _callFee, uint256 _treasuryFee) external onlyOwner() {
        require((_callFee + _treasuryFee) < 5000, "Fees too high");
        callFee = _callFee;
        treasuryFee = _treasuryFee;
    }

    /// @param _vault Vault address
    /// @param _path Tokens path
    /// @notice Sets the path to be able to swap from collateral to mStable
    function setUniRouterPath(address _vault, address[] calldata _path) external onlyOwner() {
        uniRouterPath[_vault] = _path;
    }

    /// @param _vault address of the vault
    /// @notice returns an array with vaults that can be liquidated. 
    function checkLiquidableVaults(address _vault) public view returns(uint256[] memory){
        uint256 vaultCount = IFixedVault(_vault).vaultCount();
        bool[] memory isVaultLiquidable = new bool[](vaultCount);
        uint256 liquidableCount = 0;

        for(uint256 _vaultID = 0; _vaultID < vaultCount; _vaultID++){
            isVaultLiquidable[_vaultID] = _isLiquidable(_vault, _vaultID);
            if(isVaultLiquidable[_vaultID]) {
                liquidableCount++;
            }
        }

        uint256[] memory liquidableVaults = new uint256[](liquidableCount);
        uint256 liquidableIndex = 0;

        for(uint256 _vaultID = 0; _vaultID < vaultCount; _vaultID++){
            if(isVaultLiquidable[_vaultID]){
                liquidableVaults[liquidableIndex] = _vaultID;
                liquidableIndex++;
            }
        }

        return(liquidableVaults);
    }

    /// @param _vault address of the vault
    /// @param _vaultID ID of the vault that will be liquidated
    /// @param _slippage Maximum slippage desired for the swap when liquidating. 100 = 1%
    /// @param _deadline Deadline for the swap
    /// @notice Starts the liquidation proccess
    /// @dev Profit distribution is made on uniswapV2Call callback
    function liquidateVault(address _vault, uint256 _vaultID, uint256 _slippage, uint256 _deadline) external {
        require(_isLiquidable(_vault, _vaultID), "Vault not liquidable");   

        uint256 liquidationCost = IFixedVault(_vault).checkCost(_vaultID);
        _getFlashLoan(_vault, _vaultID, liquidationCost, _slippage, _deadline);
    }

    /// @param _vault address of the vault
    /// @param _vaultID ID of the vault that will be liquidated
    /// @param _amount Flash loan amount in mStable
    /// @param _slippage Maximum slippage desired for the swap when liquidating. 100 = 1%
    /// @param _deadline Deadline for the swap
    /// @notice Gets a flash loan from a Univ2Pair
    function _getFlashLoan(address _vault, uint256 _vaultID, uint256 _amount, uint256 _slippage, uint256 _deadline) internal{
        address pair = IUniswapV2Factory(uniswapFactory).getPair(mStable, usdc);
        require(pair != address(0), "!pair");

        address token0 = IUniswapV2Pair(pair).token0();
        address token1 = IUniswapV2Pair(pair).token1();
        uint amount0Out = mStable == token0 ? _amount : 0;
        uint amount1Out = mStable == token1 ? _amount : 0;

        // need to pass some data to trigger uniswapV2Call
        bytes memory data = abi.encode(_vault, _vaultID, mStable, _amount, msg.sender, _slippage, _deadline);

        IUniswapV2Pair(pair).swap(amount0Out, amount1Out, address(this), data);
    }

    /// @param _sender Address that initiated the swap (Flash Loan)
    /// @param _amount0 Token 0 amount sent
    /// @param _amount1 Token 1 amount sent
    /// @param _data Data sent by the pair
    /// @notice Callback function where it executes the liquidation and returns the flash loan
    /// @dev Called by pair contract
    function uniswapV2Call(
        address _sender,
        uint _amount0,
        uint _amount1,
        bytes calldata _data
    ) external override {
        address token0 = IUniswapV2Pair(msg.sender).token0();
        address token1 = IUniswapV2Pair(msg.sender).token1();
        address pair = IUniswapV2Factory(uniswapFactory).getPair(token0, token1);
        require(msg.sender == pair, "!pair");
        require(_sender == address(this), "!sender");

        (address _vault, 
        uint256 _vaultID, 
        address _tokenBorrow, 
        uint256 _amount, 
        address _caller,
        uint256 _slippage,
        uint256 _deadline) = abi.decode(_data, (address, uint256, address, uint256, address, uint256, uint256));

        uint256 flFee = ((_amount * 30) / TEN_THOUSAND) + 1;
        uint256 _amountToRepay = _amount + flFee;
        address _collateral = IFixedVault(_vault).getCollateral();
        address[] memory _path = uniRouterPath[_vault];

        IFixedVault(_vault).liquidateVault(_vaultID);
        IFixedVault(_vault).getPaid();

        //TD-1. Check allowances
        uint256 _collateralBalance = IERC20(_collateral).balanceOf(address(this));
        uint256 _amountInMax = _calculateAmountInMax(_vault, _amountToRepay, _slippage);
        require(_amountInMax < _collateralBalance, "Slippage too high");
        IUniswapV2Router02(uniswapRouter).swapTokensForExactTokens(_amountToRepay, _amountInMax, _path, address(this), _deadline); 

        IERC20(_tokenBorrow).transfer(pair, _amountToRepay);

        
        uint256 _amountToDistribute = IERC20(_collateral).balanceOf(address(this));
        (uint256 _cFee, uint256 _tFee, uint256 _rpFee) = _calculateDistribution(_amountToDistribute);

        IERC20(_collateral).safeTransfer(_caller, _cFee);
        IERC20(_collateral).safeTransfer(treasury, _tFee);
        IERC20(_collateral).safeTransfer(rewardPool, _rpFee);
  }
    
    /// @param _vault address of the vault
    /// @param _vaultID ID of the vault that will be checked
    /// @notice Checks if _vaultID exists and if is liquidable
    function _isLiquidable(address _vault, uint256 _vaultID) internal view returns(bool){
        if(IFixedVault(_vault).exists(_vaultID)){
            if(IFixedVault(_vault).checkLiquidation(_vaultID)){
                return true;
            }
        }
        return false;
    }

    /// @param _amount Amount to be distributed
    /// @notice Calculates the distribution share of liquidation profits
    /// @dev Reward pool fee is the rest after deducting callFee & treasuryFee
    function _calculateDistribution(uint256 _amount) internal view returns(uint256, uint256, uint256){
        uint256 cFee = (_amount * callFee) / TEN_THOUSAND;
        uint256 tFee = (_amount * treasuryFee) / TEN_THOUSAND;
        uint256 rpFee = _amount - cFee - tFee;

        require((cFee + tFee + rpFee) == _amount, "Error when calculating rewards");

        return (cFee, tFee, rpFee);
    }

    /// @param _vault Vault address
    /// @param _amountOut Amount out of the swap
    /// @param _slippage Desired Slippage
    /// @notice Calculates the Maxiumum in amount in a swap based on the amountOut and slippage
    function _calculateAmountInMax(address _vault, uint256 _amountOut, uint256 _slippage) internal view returns(uint256){
        uint256[] memory _amountsIn = IUniswapV2Router02(uniswapRouter).getAmountsIn(_amountOut, uniRouterPath[_vault]);
        uint256 _amountIn = _amountsIn[0];
        uint256 _calculatedSlippage = (_amountIn * _slippage) / TEN_THOUSAND;

        return _amountIn + _calculatedSlippage;
    }
}