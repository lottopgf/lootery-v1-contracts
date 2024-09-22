// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ILooteryFactory} from "./interfaces/ILooteryFactory.sol";
import {ILootery} from "./interfaces/ILootery.sol";

/// @title LooteryFactory
/// @notice Launch a lotto to support your charity or public good!
contract LooteryFactory is
    ILooteryFactory,
    UUPSUpgradeable,
    AccessControlUpgradeable
{
    using StorageSlot for bytes32;

    // keccak256("troops.lootery_factory.lootery_master_copy");
    bytes32 private constant LOOTERY_MASTER_COPY_SLOT =
        0x15244694a038682b3dfdfc9a7b4d57f194bac87a538c298bbb15836f93f3d08e;
    // keccak256("troops.lootery_factory.randomiser");
    bytes32 private constant RANDOMISER_SLOT =
        0x7fd620ff951c5553351af243f95586d6c40fbde77386fa401565df721194304b;
    // keccak256("troops.lootery_factory.nonce");
    bytes32 private constant NONCE_SLOT =
        0xb673313ff65da5deee919e9043f9d191abd6721ce5d457fcf870135fe1bceb99;
    // keccak256("troops.lootery_factory.ticket_svg_renderer");
    bytes32 private constant TICKET_SVG_RENDERER_SLOT =
        0xd1c597752146589dde9c96027a1c6cda673d6fe5b448036a3b51eb9c108a913c;
    // keccak256("troops.lootery_factory.fee_recipient");
    bytes32 private constant FEE_RECIPIENT_SLOT =
        0x42ca05c9d33288b41ba8de79367abafbc42de97cbc0b0b65f9ad198e935fb6b7;

    constructor() {
        _disableInitializers();
    }

    function typeAndVersion() external pure returns (string memory) {
        return "LooteryFactory 1.6.0";
    }

    /// @notice Initialisoooooor!!! NB: Caller becomes admin.
    /// @param looteryMasterCopy Initial mastercopy of the Lootery contract
    /// @param randomiser The randomiser to be deployed with each Lootery
    function init(
        address looteryMasterCopy,
        address randomiser,
        address ticketSVGRenderer
    ) public initializer {
        __UUPSUpgradeable_init();
        __AccessControl_init();

        LOOTERY_MASTER_COPY_SLOT.getAddressSlot().value = looteryMasterCopy;
        RANDOMISER_SLOT.getAddressSlot().value = randomiser;
        TICKET_SVG_RENDERER_SLOT.getAddressSlot().value = ticketSVGRenderer;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice See {UUPSUpgradeable-_authorizeUpgrade}
    function _authorizeUpgrade(
        address newImplementation
    ) internal virtual override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function setLooteryMasterCopy(
        address looteryMasterCopy
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldLooteryMasterCopy = LOOTERY_MASTER_COPY_SLOT
            .getAddressSlot()
            .value;
        LOOTERY_MASTER_COPY_SLOT.getAddressSlot().value = looteryMasterCopy;
        emit LooteryMasterCopyUpdated(oldLooteryMasterCopy, looteryMasterCopy);
    }

    function getLooteryMasterCopy() external view returns (address) {
        return LOOTERY_MASTER_COPY_SLOT.getAddressSlot().value;
    }

    function setRandomiser(
        address randomiser
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldRandomiser = RANDOMISER_SLOT.getAddressSlot().value;
        RANDOMISER_SLOT.getAddressSlot().value = randomiser;
        emit RandomiserUpdated(oldRandomiser, randomiser);
    }

    function getRandomiser() external view returns (address) {
        return RANDOMISER_SLOT.getAddressSlot().value;
    }

    function setTicketSVGRenderer(
        address ticketSVGRenderer
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldTicketSVGRenderer = TICKET_SVG_RENDERER_SLOT
            .getAddressSlot()
            .value;
        TICKET_SVG_RENDERER_SLOT.getAddressSlot().value = ticketSVGRenderer;
        emit TicketSVGRendererUpdated(oldTicketSVGRenderer, ticketSVGRenderer);
    }

    function getTicketSVGRenderer() external view returns (address) {
        return TICKET_SVG_RENDERER_SLOT.getAddressSlot().value;
    }

    function setFeeRecipient(
        address feeRecipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        FEE_RECIPIENT_SLOT.getAddressSlot().value = feeRecipient;
    }

    function getFeeRecipient() external view returns (address) {
        return FEE_RECIPIENT_SLOT.getAddressSlot().value;
    }

    /// @notice Compute salt used in computing deployment addresses
    function computeSalt(uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(nonce, "lootery"));
    }

    /// @notice Compute the address at which the next lotto will be deployed
    function computeNextAddress() external view returns (address) {
        uint256 nonce = NONCE_SLOT.getUint256Slot().value;
        bytes32 salt = computeSalt(nonce);
        return
            Clones.predictDeterministicAddress(
                LOOTERY_MASTER_COPY_SLOT.getAddressSlot().value,
                salt
            );
    }

    /// @notice Launch your own lotto
    /// @param name Name of the lotto (also used for ticket NFTs)
    /// @param symbol Symbol of the lotto (used for ticket NFTs)
    /// @param pickLength Number of balls that must be picked per draw
    /// @param maxBallValue Maximum value that a picked ball can have
    ///     (excludes 0)
    /// @param gamePeriod The number of seconds that must pass before a draw
    ///     can be initiated.
    /// @param ticketPrice Price per ticket
    /// @param communityFeeBps The percentage of the ticket price that should
    ///     be taken and accrued for the lotto owner.
    /// @param prizeToken The ERC-20 token that will be used as the prize token
    ///     and also the token that will be used to pay for tickets.
    /// @param seedJackpotDelay The number of seconds that must pass before the
    ///     jackpot can be seeded again.
    /// @param seedJackpotMinValue The minimum value that the jackpot must be
    ///     seeded with.
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
    ) external returns (address) {
        ILootery.InitConfig memory config = ILootery.InitConfig({
            owner: msg.sender,
            name: name,
            symbol: symbol,
            pickLength: pickLength,
            maxBallValue: maxBallValue,
            gamePeriod: gamePeriod,
            ticketPrice: ticketPrice,
            communityFeeBps: communityFeeBps,
            randomiser: RANDOMISER_SLOT.getAddressSlot().value,
            prizeToken: prizeToken,
            seedJackpotDelay: seedJackpotDelay,
            seedJackpotMinValue: seedJackpotMinValue,
            ticketSVGRenderer: TICKET_SVG_RENDERER_SLOT.getAddressSlot().value
        });

        uint256 nonce = NONCE_SLOT.getUint256Slot().value++;
        bytes32 salt = computeSalt(nonce);
        address looteryMasterCopy = LOOTERY_MASTER_COPY_SLOT
            .getAddressSlot()
            .value;
        // Deploy & init proxy
        address payable looteryProxy = payable(
            Clones.cloneDeterministic(looteryMasterCopy, salt)
        );
        ILootery(looteryProxy).init(config);
        emit LooteryLaunched(
            looteryProxy,
            looteryMasterCopy,
            msg.sender,
            config.name
        );
        return looteryProxy;
    }
}
