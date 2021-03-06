import CreateOperation from './CreateOperation';
import DocumentModel from './models/DocumentModel';
import Encoder from './Encoder';
import ErrorCode from './ErrorCode';
import Jws from './util/Jws';
import JwsModel from './models/JwsModel';
import KeyUsage from './KeyUsage';
import Multihash from './Multihash';
import OperationModel from './models/OperationModel';
import OperationType from '../../enums/OperationType';
import PublicKeyModel from '../../models/PublicKeyModel';
import RecoverOperation from './RecoverOperation';
import RevokeOperation from './RevokeOperation';
import SidetreeError from '../../SidetreeError';
import UpdateOperation from './UpdateOperation';

/**
 * A class that represents a Sidetree operation.
 * The primary purpose of this class is to provide an abstraction to the underlying JSON data structure.
 *
 * NOTE: Design choices of:
 * 1. No subclassing of specific operations. The intention here is to keep the hierarchy flat, as most properties are common.
 * 2. Factory method to hide constructor in case subclassing becomes useful in the future. Most often a good practice anyway.
 */
export default class Operation {
  /** The original request buffer sent by the requester. */
  public readonly operationBuffer: Buffer;
  /** The encoded protected header. */
  public encodedProtectedHeader!: string;
  /** The encoded operation payload. */
  public encodedPayload!: string;

  /**
   * The unique suffix of the DID of the DID document to be created/updated.
   * If this is a create operation waiting to be anchored, a DID unique suffix will be generated based on the current blockchain time.
   */
  public didUniqueSuffix!: string;

  /** Hash of the operation based on the encoded payload string. */
  public operationHash!: string;

  /** The type of operation. */
  public type!: OperationType;
  /** ID of the key used to sign this operation. */
  public signingKeyId!: string;
  /** Signature of this operation. */
  public signature!: string;

  /** DID document given in the operation, only applicable to create and recover operations, undefined otherwise. */
  public didDocument?: DocumentModel;
  /** Encoded DID document - mainly used for DID generation. */
  public encodedDidDocument?: string;

  /** Patches to the DID Document, only applicable to update operations, undefined otherwise. */
  public patches?: any[];

  /** One-time password for this update operation. */
  public updateOtp?: string;
  /** One-time password for this recovery/checkpoint/revoke operation. */
  public recoveryOtp?: string;
  /** Hash of the one-time password for the next update operation. */
  public nextUpdateOtpHash?: string;
  /** Hash of the one-time password for this recovery/checkpoint/revoke operation. */
  public nextRecoveryOtpHash?: string;

  /**
   * Constructs an Operation if the operation buffer passes schema validation, throws error otherwise.
   * NOTE: Would love to mark this constructor private to prevent direct calls, but need it to be public for `AnchoredOperation` to inherit from.
   */
  public constructor (operationBuffer: Buffer) {
    this.operationBuffer = operationBuffer;

    // Parse request buffer into a JS object.
    const operationJson = operationBuffer.toString();
    const operation = JSON.parse(operationJson) as JwsModel;

    // Ensure that the operation is well-formed and initialize instance variables.
    this.parseAndInitializeOperation(operation);
  }

  /**
   * Parses the given buffer into an `OperationModel`.
   */
  public static async parse (operationBuffer: Buffer): Promise<OperationModel> {
    // Parse request buffer into a JS object.
    const operationJsonString = operationBuffer.toString();
    const operationObject = JSON.parse(operationJsonString);
    const operationType = operationObject.type;

    if (operationType === OperationType.Create) {
      return CreateOperation.parseObject(operationObject, operationBuffer);
    } else if (operationType === OperationType.Update) {
      return UpdateOperation.parseObject(operationObject, operationBuffer);
    } else if (operationType === OperationType.Recover) {
      return RecoverOperation.parseObject(operationObject, operationBuffer);
    } else if (operationType === OperationType.Revoke) {
      return RevokeOperation.parseObject(operationObject, operationBuffer);
    } else {
      throw new SidetreeError(ErrorCode.OperationTypeUnknownOrMissing);
    }
  }

  /**
   * Verifies the operation is signed correctly.
   * @param publicKey The public key used for verification.
   * @returns true if signature is successfully verified, false otherwise.
   */
  public async verifySignature (publicKey: PublicKeyModel): Promise<boolean> {
    const verified = await Jws.verifySignature(this.encodedProtectedHeader, this.encodedPayload, this.signature, publicKey);
    return verified;
  }

  /**
   * Computes the cryptographic multihash of the given string.
   */
  private static computeHash (dataString: string): string {
    const encodedOperationPayloadBuffer = Buffer.from(dataString);
    const multihash = Multihash.hash(encodedOperationPayloadBuffer);
    const encodedMultihash = Encoder.encode(multihash);
    return encodedMultihash;
  }

  /**
   * Applies the given patches in order to the given DID Document.
   * NOTE: Assumes no schema validation is needed.
   */
  public static applyPatchesToDidDocument (didDocument: DocumentModel, patches: any[]) {
    // Loop through and apply all patches.
    for (let patch of patches) {
      Operation.applyPatchToDidDocument(didDocument, patch);
    }
  }

  /**
   * Applies the given patch to the given DID Document.
   */
  private static applyPatchToDidDocument (didDocument: DocumentModel, patch: any) {
    if (patch.action === 'add-public-keys') {
      const publicKeySet = new Set(didDocument.publicKey.map(key => key.id));

      // Loop through all given public keys and add them if they don't exist already.
      for (let publicKey of patch.publicKeys) {
        if (!publicKeySet.has(publicKey.id)) {
          // Add the controller property. This cannot be added by the client and can
          // only be set by the server side
          publicKey.controller = didDocument.id;
          didDocument.publicKey.push(publicKey);
        }
      }
    } else if (patch.action === 'remove-public-keys') {
      const publicKeyMap = new Map(didDocument.publicKey.map(publicKey => [publicKey.id, publicKey]));

      // Loop through all given public key IDs and delete them from the existing public key only if it is not a recovery key.
      for (let publicKey of patch.publicKeys) {
        const existingKey = publicKeyMap.get(publicKey);

        // Deleting recovery key is NOT allowed.
        if (existingKey !== undefined &&
            existingKey.usage !== KeyUsage.recovery) {
          publicKeyMap.delete(publicKey);
        }
      }

      didDocument.publicKey = [...publicKeyMap.values()];
    } else if (patch.action === 'add-service-endpoints') {
      // Find the service of the given service type.
      let service = undefined;
      if (didDocument.service !== undefined) {
        service = didDocument.service.find(service => service.type === patch.serviceType);
      }

      // If service not found, create a new service element and add it to the property.
      if (service === undefined) {
        service = {
          type: patch.serviceType,
          serviceEndpoint: {
            '@context': 'schema.identity.foundation/hub',
            '@type': 'UserServiceEndpoint',
            instances: patch.serviceEndpoints
          }
        };

        if (didDocument.service === undefined) {
          didDocument.service = [service];
        } else {
          didDocument.service.push(service);
        }
      } else {
        // Else we add to the eixsting service element.

        const serviceEndpointSet = new Set(service.serviceEndpoint.instances);

        // Loop through all given service endpoints and add them if they don't exist already.
        for (let serviceEndpoint of patch.serviceEndpoints) {
          if (!serviceEndpointSet.has(serviceEndpoint)) {
            service.serviceEndpoint.instances.push(serviceEndpoint);
          }
        }
      }
    } else if (patch.action === 'remove-service-endpoints') {
      let service = undefined;
      if (didDocument.service !== undefined) {
        service = didDocument.service.find(service => service.type === patch.serviceType);
      }

      if (service === undefined) {
        return;
      }

      const serviceEndpointSet = new Set(service.serviceEndpoint.instances);

      // Loop through all given public key IDs and add them from the existing public key set.
      for (let serviceEndpoint of patch.serviceEndpoints) {
        serviceEndpointSet.delete(serviceEndpoint);
      }

      service.serviceEndpoint.instances = [...serviceEndpointSet];
    }
  }

  /**
   * Parses and validates the given operation object object.
   * NOTE: Operation validation does not include signature verification.
   * @returns [decoded protected header JSON object, decoded payload JSON object] if given operation JWS is valid, Error is thrown otherwise.
   */
  private parseAndInitializeOperation (operation: any) {
    const jws = Jws.parse(operation);

    // Decode the encoded operation string.
    const decodedPayloadJson = Encoder.decodeAsString(operation.payload);
    const decodedPayload = JSON.parse(decodedPayloadJson);

    // Get the operation type.
    const operationType = decodedPayload.type;

    // 'type' property must be one of the allowed strings.
    const allowedOperations = new Set(Object.values(OperationType));
    if (typeof operationType !== 'string' ||
        !allowedOperations.has(operationType as OperationType)) {
      throw new SidetreeError(ErrorCode.OperationPayloadMissingOrIncorrectType);
    }

    // Initialize common operation properties.
    this.type = decodedPayload.type;
    this.signingKeyId = jws.kid;
    this.encodedProtectedHeader = operation.protected;
    this.encodedPayload = operation.payload;
    this.signature = operation.signature;
    this.operationHash = Operation.computeHash(this.encodedPayload);

    // Verify operation specific payload schema and further decode if needed, then initialize.
    switch (this.type) {
      case OperationType.Create:
        // additional parsing required because did doc is nest base64url encoded
        decodedPayload.didDocument = JSON.parse(Encoder.decodeAsString(decodedPayload.didDocument));
        this.didUniqueSuffix = this.operationHash;
        this.didDocument = decodedPayload.didDocument;
        this.nextRecoveryOtpHash = decodedPayload.nextRecoveryOtpHash;
        this.nextUpdateOtpHash = decodedPayload.nextUpdateOtpHash;
        break;
      case OperationType.Update:
        this.didUniqueSuffix = decodedPayload.didUniqueSuffix;
        this.patches = decodedPayload.patches;
        this.updateOtp = decodedPayload.updateOtp;
        this.nextUpdateOtpHash = decodedPayload.nextUpdateOtpHash;
        break;
      case OperationType.Recover:
        // additional parsing required because did doc is nest base64url encoded
        decodedPayload.newDidDocument = JSON.parse(Encoder.decodeAsString(decodedPayload.newDidDocument));
        this.didUniqueSuffix = decodedPayload.didUniqueSuffix;
        this.didDocument = decodedPayload.newDidDocument;
        this.recoveryOtp = decodedPayload.recoveryOtp;
        this.nextRecoveryOtpHash = decodedPayload.nextRecoveryOtpHash;
        this.nextUpdateOtpHash = decodedPayload.nextUpdateOtpHash;
        break;
      case OperationType.Revoke:
        this.didUniqueSuffix = decodedPayload.didUniqueSuffix;
        this.recoveryOtp = decodedPayload.recoveryOtp;
        break;
      default:
        throw new Error(`Not implemented operation type ${this.type}.`);
    }
  }

  /** Maximum allowed encoded OTP string length. */
  public static readonly maxEncodedOtpLength = 50;

  /**
   * Validates the given recovery key object is in valid format.
   * @throws SidetreeError if given recovery key is invalid.
   */
  public static validateRecoveryKeyObject (recoveryKey: any) {
    if (recoveryKey === undefined) {
      throw new SidetreeError(ErrorCode.OperationRecoveryKeyUndefined);
    }

    const recoveryKeyObjectPropertyCount = Object.keys(recoveryKey);
    if (recoveryKeyObjectPropertyCount.length !== 1 ||
        typeof recoveryKey.publicKeyHex !== 'string') {
      throw new SidetreeError(ErrorCode.OperationRecoveryKeyInvalid);
    }
  }
}
