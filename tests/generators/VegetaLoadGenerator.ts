import * as fs from 'fs';
import CreateOperation from '../../lib/core/versions/latest/CreateOperation';
import Cryptography from '../../lib/core/versions/latest/util/Cryptography';
import KeyUsage from '../../lib/core/versions/latest/KeyUsage';
import OperationGenerator from './OperationGenerator';

/**
 * Class for generating files used for load testing using Vegeta.
 */
export default class VegetaLoadGenerator {

  /**
   * Creates a Create request followed by an Update request for each DID.
   * Two targets files will be generated:
   *   One targets file containing all Create requests;
   *   One targest file containing all Update requests
   * @param uniqueDidCount The number of unique DID to be generated.
   * @param endpointUrl The URL that the requests will be sent to.
   * @param absoluteFolderPath The folder that all the generated files will be saved to.
   * @param hashAlgorithmInMultihashCode The hash algorithm in Multihash code in DEC (not in HEX).
   */
  public static async generateLoadFiles (uniqueDidCount: number, endpointUrl: string, absoluteFolderPath: string) {
    // Make directories needed by the request generator.
    fs.mkdirSync(absoluteFolderPath);
    fs.mkdirSync(absoluteFolderPath + '/keys');
    fs.mkdirSync(absoluteFolderPath + '/requests');

    for (let i = 0; i < uniqueDidCount; i++) {
      // Generate a random pair of public-private key pair and save them on disk.
      const [recoveryPublicKey, recoveryPrivateKey] = await Cryptography.generateKeyPairHex('#recoveryKey', KeyUsage.recovery);
      fs.writeFileSync(absoluteFolderPath + `/keys/recoveryPrivateKey${i}.json`, JSON.stringify(recoveryPrivateKey));
      fs.writeFileSync(absoluteFolderPath + `/keys/recoveryPublicKey${i}.json`, JSON.stringify(recoveryPublicKey));

      const signingKeyId = '#signingKey';
      const [signingPublicKey, signingPrivateKey] = await Cryptography.generateKeyPairHex(signingKeyId, KeyUsage.signing);
      const services = OperationGenerator.createIdentityHubUserServiceEndpoints(['did:sidetree:value0']);

      const [recover1OTP, recoveryOtpHash] = OperationGenerator.generateOtp();
      const [, recovery2OtpHash] = OperationGenerator.generateOtp();
      const [update1Otp, update1OtpHash] = OperationGenerator.generateOtp();
      const [, update2OtpHash] = OperationGenerator.generateOtp();

      // Generate the Create request body and save it on disk.
      const createOperationBuffer = await OperationGenerator.generateCreateOperationBuffer(
        recoveryPublicKey,
        signingPublicKey,
        recoveryOtpHash,
        update1OtpHash,
        services
      );
      fs.writeFileSync(absoluteFolderPath + `/requests/create${i}.json`, createOperationBuffer);

      // Compute the DID unique suffix from the generated Create payload.
      const createOperation = await CreateOperation.parse(createOperationBuffer);
      const didUniqueSuffix = createOperation.didUniqueSuffix;

      // Generate an update operation
      const updateOperationRequest = await OperationGenerator.createUpdateOperationRequestForAddingAKey(
        didUniqueSuffix, update1Otp, '#additionalKey', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', update2OtpHash, signingKeyId, signingPrivateKey
      );

      // Save the update operation request on disk.
      const updateOperationBuffer = Buffer.from(JSON.stringify(updateOperationRequest));
      fs.writeFileSync(absoluteFolderPath + `/requests/update${i}.json`, updateOperationBuffer);

      // Generate a recover operation request.
      const [newRecoveryPublicKey] = await Cryptography.generateKeyPairHex('#newRecoveryKey', KeyUsage.recovery);
      const [newSigningPublicKey] = await Cryptography.generateKeyPairHex('#newSigningKey', KeyUsage.recovery);
      const recoverOperationRequest = await OperationGenerator.generateRecoverOperationRequest(
        didUniqueSuffix, recover1OTP, recoveryPrivateKey, newRecoveryPublicKey, newSigningPublicKey, recovery2OtpHash, update2OtpHash
      );

      // Save the recover operation request on disk.
      const recoverOperationBuffer = Buffer.from(JSON.stringify(recoverOperationRequest));
      fs.writeFileSync(`${absoluteFolderPath}/requests/recovery${i}.json`, recoverOperationBuffer);
    }

    // Generate Create API calls in a targets file.
    let createTargetsFileString = '';
    for (let i = 0; i < uniqueDidCount; i++) {
      createTargetsFileString += `POST ${endpointUrl}\n`;
      createTargetsFileString += `@${absoluteFolderPath}/requests/create${i}.json\n\n`;
    }
    fs.writeFileSync(absoluteFolderPath + '/createTargets.txt', createTargetsFileString);

    // Add Updtae API calls in a targets file.
    let updateTargetsFileString = '';
    for (let i = 0; i < uniqueDidCount; i++) {
      updateTargetsFileString += `POST ${endpointUrl}\n`;
      updateTargetsFileString += `@${absoluteFolderPath}/requests/update${i}.json\n\n`;
    }
    fs.writeFileSync(absoluteFolderPath + '/updateTargets.txt', updateTargetsFileString);

    // Add Recovery API calls in a targets file.
    let recoveryTargetsFileString = '';
    for (let i = 0; i < uniqueDidCount; i++) {
      recoveryTargetsFileString += `POST ${endpointUrl}\n`;
      recoveryTargetsFileString += `@${absoluteFolderPath}/requests/recovery${i}.json\n\n`;
    }
    fs.writeFileSync(absoluteFolderPath + '/recoveryTargets.txt', recoveryTargetsFileString);
  }
}
