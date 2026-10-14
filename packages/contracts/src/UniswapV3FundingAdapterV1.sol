// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IV3Router02 {
    struct ExactOutputParams { bytes path; address recipient; uint256 amountOut; uint256 amountInMaximum; }
    function factory() external view returns (address);
    function exactOutput(ExactOutputParams calldata p) external payable returns (uint256 amountIn);
}
interface IV3Factory { function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address); }

/// @notice One pinned USDC→JPYC hop. No generic calls, deposits, withdrawals or upgrades.
contract UniswapV3FundingAdapterV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable gate;
    IERC20 public immutable input;
    IERC20 public immutable output;
    IV3Router02 public immutable router;
    IV3Factory public immutable factory;
    error InvalidFunding();
    constructor(address g, address usdc, address jpyc, address r, address f) {
        if (g == address(0) || r.code.length == 0 || f.code.length == 0 || IV3Router02(r).factory() != f) revert InvalidFunding();
        gate = g; input = IERC20(usdc); output = IERC20(jpyc); router = IV3Router02(r); factory = IV3Factory(f);
    }
    function fund(address owner, uint256 maximum, uint256 amountOut, uint64 until, bytes calldata path) external nonReentrant returns (uint256 actual) {
        if (msg.sender != gate || owner == address(0) || owner == address(this) || owner == gate || until <= block.timestamp || maximum == 0 || amountOut == 0 || path.length != 43) revert InvalidFunding();
        // Exact-output paths run from output to input, unlike exact-input paths.
        if (address(bytes20(path[0:20])) != address(output) || address(bytes20(path[23:43])) != address(input)) revert InvalidFunding();
        uint24 fee = uint24(bytes3(path[20:23]));
        if (fee != 100 && fee != 500 && fee != 3000 && fee != 10000) revert InvalidFunding();
        if (factory.getPool(address(input), address(output), fee).code.length == 0) revert InvalidFunding();
        uint256 beforeInput = input.balanceOf(address(this));
        uint256 beforeOutput = output.balanceOf(address(this));
        uint256 beforeOwnerOutput = output.balanceOf(owner);
        input.safeTransferFrom(gate, address(this), maximum);
        if (input.balanceOf(address(this)) != beforeInput + maximum) revert InvalidFunding();
        input.forceApprove(address(router), maximum);
        actual = router.exactOutput(IV3Router02.ExactOutputParams(path, owner, amountOut, maximum));
        input.forceApprove(address(router), 0);
        if (actual == 0 || actual > maximum || input.balanceOf(address(this)) != beforeInput + maximum - actual || output.balanceOf(owner) != beforeOwnerOutput + amountOut) revert InvalidFunding();
        if (maximum > actual) input.safeTransfer(owner, maximum - actual);
        if (input.balanceOf(address(this)) != beforeInput || output.balanceOf(address(this)) != beforeOutput || input.allowance(address(this), address(router)) != 0) revert InvalidFunding();
    }
}
