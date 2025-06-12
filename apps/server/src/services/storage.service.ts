import AdmZip from 'adm-zip';
import storageRepository from '../repositories/storage.repository';

export default {
  zipAll(roomCode: string) {
    const files = storageRepository.loadAll(roomCode);
    const zip = new AdmZip();
    let hasReadme = false;
    files.forEach((file) => {
      zip.addFile(file.filename, Buffer.from(file.data));
      if (file.filename === 'README.txt') {
        hasReadme = true;
      }
    });
    if (!hasReadme) {
      const dateString = new Date().toISOString();
      zip.addFile(
        'README.txt',
        Buffer.from(
          `This zip file contains all files uploaded to room ${roomCode}. Downloaded on ${dateString}.\n`,
        ),
      );
    }
    return zip.toBuffer();
  },
};
