// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

interface IAnyrand {
    /// @notice State of a request
    enum RequestState {
        /// @notice The request does not exist
        Nonexistent,
        /// @notice A request has been made, waiting for fulfilment
        Pending,
        /// @notice The request has been fulfilled successfully
        Fulfilled,
        /// @notice The request was fulfilled, but the callback failed
        Failed
    }

    /// @notice Compute the total request price
    /// @param callbackGasLimit The callback gas limit that will be used for
    ///     the randomness request
    function getRequestPrice(
        uint256 callbackGasLimit
    ) external view returns (uint256 totalPrice, uint256 effectiveFeePerGas);

    /// @notice Request randomness
    /// @param deadline Timestamp of when the randomness should be fulfilled. A
    ///     beacon round closest to this timestamp (rounding up to the nearest
    ///     future round) will be used as the round from which to derive
    ///     randomness.
    /// @param callbackGasLimit Gas limit for callback
    function requestRandomness(
        uint256 deadline,
        uint256 callbackGasLimit
    ) external payable returns (uint256);

    /// @notice Get the state of a request
    /// @param requestId The request identifier
    function getRequestState(
        uint256 requestId
    ) external view returns (RequestState);
}
