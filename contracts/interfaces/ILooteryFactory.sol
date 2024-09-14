// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/// @title ILooteryFactory
/// @custom:version 1.2.0
/// @notice Launch a lotto to support your charity or public good.
interface ILooteryFactory {
    event LooteryLaunched(
        address indexed looteryProxy,
        address indexed looteryImplementation,
        address indexed deployer,
        string name
    );
    event LooteryMasterCopyUpdated(
        address oldLooteryMasterCopy,
        address newLooteryMasterCopy
    );
    event RandomiserUpdated(address oldRandomiser, address newRandomiser);
    event TicketSVGRendererUpdated(
        address oldTicketSVGRenderer,
        address newTicketSVGRenderer
    );

    function init(
        address looteryMasterCopy,
        address randomiser,
        address ticketSVGRenderer
    ) external;

    function setLooteryMasterCopy(address looteryMasterCopy) external;

    function getLooteryMasterCopy() external view returns (address);

    function setRandomiser(address randomiser) external;

    function getRandomiser() external view returns (address);

    function setTicketSVGRenderer(address ticketSVGRenderer) external;

    function getTicketSVGRenderer() external view returns (address);

    function setFeeRecipient(address feeRecipient) external;

    function getFeeRecipient() external view returns (address);

    function computeNextAddress() external view returns (address);

    function create(
        string memory name,
        string memory symbol,
        uint8 pickLength,
        uint8 maxBallValue,
        uint256 gamePeriod,
        uint256 ticketPrice,
        uint256 communityFeeBps,
        address prizeToken,
        uint256 seedJackpotDelay,
        uint256 seedJackpotMinValue
    ) external returns (address);
}
