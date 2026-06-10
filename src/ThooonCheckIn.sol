// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ThooonCheckIn — daily on-chain check-in for the Thooon game on Celo.
/// @notice Immutable and ownerless. One check-in per address per UTC day.
///         The nonce is an opaque server-issued value that binds this
///         transaction to a Thooon account; it carries no on-chain meaning.
/// @dev    Designed for MiniPay: cheap (~35-50k gas), legacy/CIP-64 friendly,
///         fee payable in stablecoins via the feeCurrency tx field.
contract ThooonCheckIn {
    event CheckIn(
        address indexed account,
        bytes32 indexed nonce,
        uint256 day,
        uint32 streak
    );

    mapping(address => uint256) public lastCheckInDay;
    mapping(address => uint32) public streakOf;

    error AlreadyCheckedInToday();

    /// @param nonce Server-issued challenge binding this tx to a game account.
    function checkIn(bytes32 nonce) external {
        uint256 day = block.timestamp / 1 days;
        uint256 last = lastCheckInDay[msg.sender];
        if (last == day) revert AlreadyCheckedInToday();

        uint32 streak = (last == day - 1) ? streakOf[msg.sender] + 1 : 1;
        streakOf[msg.sender] = streak;
        lastCheckInDay[msg.sender] = day;

        emit CheckIn(msg.sender, nonce, day, streak);
    }

    function hasCheckedInToday(address account) external view returns (bool) {
        return lastCheckInDay[account] == block.timestamp / 1 days;
    }
}
