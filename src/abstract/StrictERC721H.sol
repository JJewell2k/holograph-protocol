/*HOLOGRAPH_LICENSE_HEADER*/

/*SOLIDITY_COMPILER_VERSION*/

import "../interface/HolographedERC721.sol";

import "./ERC721H.sol";

abstract contract StrictERC721H is ERC721H, HolographedERC721 {
  /**
   * @dev Dummy variable to prevent empty functions from making "switch to pure" warnings.
   */
  bool private _success;

  function bridgeIn(
    uint32, /* _chainId*/
    address, /* _from*/
    address, /* _to*/
    uint256, /* _tokenId*/
    bytes calldata /* _data*/
  ) external virtual onlyHolographer returns (bool) {
    _success = true;
    return true;
  }

  function bridgeOut(
    uint32, /* _chainId*/
    address, /* _from*/
    address, /* _to*/
    uint256 /* _tokenId*/
  ) external virtual onlyHolographer returns (bytes memory _data) {
    _success = true;
    _data = abi.encode(holographer());
  }

  function afterApprove(
    address, /* _owner*/
    address, /* _to*/
    uint256 /* _tokenId*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function beforeApprove(
    address, /* _owner*/
    address, /* _to*/
    uint256 /* _tokenId*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function afterApprovalAll(
    address, /* _sender*/
    address, /* _to*/
    bool /* _approved*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function beforeApprovalAll(
    address, /* _sender*/
    address, /* _to*/
    bool /* _approved*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function afterBurn(
    address, /* _owner*/
    uint256 /* _tokenId*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function beforeBurn(
    address, /* _owner*/
    uint256 /* _tokenId*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function afterMint(
    address, /* _owner*/
    uint256 /* _tokenId*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function beforeMint(
    address, /* _owner*/
    uint256 /* _tokenId*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function afterSafeTransfer(
    address, /* _from*/
    address, /* _to*/
    uint256, /* _tokenId*/
    bytes calldata /* _data*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function beforeSafeTransfer(
    address, /* _from*/
    address, /* _to*/
    uint256, /* _tokenId*/
    bytes calldata /* _data*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function afterTransfer(
    address, /* _from*/
    address, /* _to*/
    uint256, /* _tokenId*/
    bytes calldata /* _data*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function beforeTransfer(
    address, /* _from*/
    address, /* _to*/
    uint256, /* _tokenId*/
    bytes calldata /* _data*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function afterOnERC721Received(
    address, /* _operator*/
    address, /* _from*/
    address, /* _to*/
    uint256, /* _tokenId*/
    bytes calldata /* _data*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }

  function beforeOnERC721Received(
    address, /* _operator*/
    address, /* _from*/
    address, /* _to*/
    uint256, /* _tokenId*/
    bytes calldata /* _data*/
  ) external virtual onlyHolographer returns (bool success) {
    _success = true;
    return _success;
  }
}
