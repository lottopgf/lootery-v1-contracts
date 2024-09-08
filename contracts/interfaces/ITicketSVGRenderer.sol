// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface ITicketSVGRenderer is IERC165 {
    error EmptyPicks();
    error UnsortedPicks(uint8[] picks);
    error OutOfRange(uint8 pick, uint8 maxPick);

    /// @notice Render raw SVG
    /// @param name Name/title of the ticket
    /// @param picks Picks must be sorted ascendingly
    /// @param maxPick Maximum pick number
    function renderSVG(
        string memory name,
        uint8 maxPick,
        uint8[] memory picks
    ) external view returns (string memory);

    /// @notice Render Base64-encoded JSON metadata
    /// @param name Name/title of the ticket
    /// @param picks Picks must be sorted ascendingly
    /// @param maxPick Maximum pick number
    function renderTokenURI(
        string memory name,
        uint256 tokenId,
        uint8 maxPick,
        uint8[] memory picks
    ) external view returns (string memory);
}
