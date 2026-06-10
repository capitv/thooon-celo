// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ThooonCheckIn} from "../src/ThooonCheckIn.sol";

contract ThooonCheckInTest is Test {
    ThooonCheckIn internal checkIn;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    event CheckIn(
        address indexed account,
        bytes32 indexed nonce,
        uint256 day,
        uint32 streak
    );

    function setUp() public {
        checkIn = new ThooonCheckIn();
        // Start at a realistic timestamp (not 0) so day math is meaningful.
        vm.warp(1_750_000_000);
    }

    function _day() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function test_FirstCheckInEmitsStreakOne() public {
        bytes32 nonce = keccak256("challenge-1");

        vm.expectEmit(true, true, false, true);
        emit CheckIn(alice, nonce, _day(), 1);

        vm.prank(alice);
        checkIn.checkIn(nonce);

        assertEq(checkIn.lastCheckInDay(alice), _day());
        assertEq(checkIn.streakOf(alice), 1);
        assertTrue(checkIn.hasCheckedInToday(alice));
    }

    function test_RevertWhen_SameDayDoubleCheckIn() public {
        vm.prank(alice);
        checkIn.checkIn(bytes32(0));

        vm.expectRevert(ThooonCheckIn.AlreadyCheckedInToday.selector);
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(1)));
    }

    function test_StreakIncrementsOnConsecutiveDays() public {
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(1)));

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(2)));

        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, false, true);
        emit CheckIn(alice, bytes32(uint256(3)), _day() + 1, 3);
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(3)));

        assertEq(checkIn.streakOf(alice), 3);
    }

    function test_StreakResetsAfterGap() public {
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(1)));
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(2)));
        assertEq(checkIn.streakOf(alice), 2);

        // Skip a day -> streak resets to 1.
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(3)));
        assertEq(checkIn.streakOf(alice), 1);
    }

    function test_AccountsAreIndependent() public {
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(1)));

        assertFalse(checkIn.hasCheckedInToday(bob));
        vm.prank(bob);
        checkIn.checkIn(bytes32(uint256(2)));

        assertEq(checkIn.streakOf(alice), 1);
        assertEq(checkIn.streakOf(bob), 1);
    }

    function test_HasCheckedInTodayFlipsAtDayBoundary() public {
        vm.prank(alice);
        checkIn.checkIn(bytes32(0));
        assertTrue(checkIn.hasCheckedInToday(alice));

        // Move to the first second of the next UTC day.
        uint256 nextDayStart = (_day() + 1) * 1 days;
        vm.warp(nextDayStart);
        assertFalse(checkIn.hasCheckedInToday(alice));
    }

    function testFuzz_NeverTwoCheckInsSameDay(uint64 startTs, uint32 offsetSameDay) public {
        // Keep timestamps sane and within the same UTC day for the second call.
        startTs = uint64(bound(startTs, 1 days, type(uint48).max));
        vm.warp(startTs);
        uint256 day = _day();
        uint256 dayEnd = (day + 1) * 1 days - 1;
        uint256 secondTs = bound(uint256(offsetSameDay) + startTs, startTs, dayEnd);

        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(1)));

        vm.warp(secondTs);
        vm.expectRevert(ThooonCheckIn.AlreadyCheckedInToday.selector);
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(2)));
    }

    function testFuzz_StreakMatchesGapRule(uint8 gapDays) public {
        gapDays = uint8(bound(gapDays, 1, 60));

        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(1)));

        vm.warp(block.timestamp + uint256(gapDays) * 1 days);
        vm.prank(alice);
        checkIn.checkIn(bytes32(uint256(2)));

        if (gapDays == 1) {
            assertEq(checkIn.streakOf(alice), 2);
        } else {
            assertEq(checkIn.streakOf(alice), 1);
        }
    }
}
