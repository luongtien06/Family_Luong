/**
 * Cloudflare Worker Backend for Family_Luong
 * Hỗ trợ đồng bộ nguyên khối (Atomic Git Data API) ảnh và data.json lên GitHub Repository.
 * 
 * Bảo mật:
 * - GitHub PAT được lưu trữ trong Cloudflare Secrets (GITHUB_PAT), không để lộ ra ngoài.
 * - Yêu cầu xác thực Admin qua Header `Authorization: Bearer <ADMIN_SECRET>`.
 * - Hỗ trợ CORS chọn lọc, kiểm tra Magic Bytes định dạng ảnh, chống tấn công ghi đè.
 */

// Tiện ích CORS
function handleCors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  // Cho phép origin nếu nằm trong danh sách hoặc nếu đang chạy localhost/127.0.0.1
  let isAllowed = allowedOrigins.includes(origin);
  if (!isAllowed && origin) {
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        isAllowed = true;
      }
    } catch (e) {}
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': isAllowed ? origin : (allowedOrigins[0] || '*'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  return corsHeaders;
}

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  });
}

function errorResponse(message, status = 400, corsHeaders = {}, details = null) {
  const body = { error: true, message };
  if (details) body.details = details;
  return jsonResponse(body, status, corsHeaders);
}

// Kiểm tra quyền Quản trị viên
function checkAdminAuth(request, env) {
  const expectedSecret = env.ADMIN_SECRET;
  if (!expectedSecret) {
    return { ok: false, status: 500, message: 'Server chưa cấu hình ADMIN_SECRET trong Cloudflare Secrets!' };
  }

  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';

  if (!token || token !== expectedSecret) {
    return { ok: false, status: 401, message: 'Không có quyền truy cập. Token quản trị không hợp lệ!' };
  }

  return { ok: true };
}

// Kiểm tra định dạng Magic Bytes ảnh
function validateImageMagicBytes(base64Data) {
  try {
    const rawData = atob(base64Data.slice(0, 64));
    const bytes = [];
    for (let i = 0; i < Math.min(rawData.length, 16); i++) {
      bytes.push(rawData.charCodeAt(i));
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return { valid: true, format: 'jpeg' };
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return { valid: true, format: 'png' };
    }
    // WebP: RIFF .... WEBP (bytes 0-3: 52 49 46 46, bytes 8-11: 57 45 42 50)
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return { valid: true, format: 'webp' };
    }

    return { valid: false, error: 'Định dạng tệp không phải JPEG, PNG hoặc WebP hợp lệ!' };
  } catch (e) {
    return { valid: false, error: 'Dữ liệu ảnh base64 không giải mã được!' };
  }
}

// Gọi GitHub API an toàn
async function callGitHubApi(endpoint, env, options = {}) {
  const token = env.GITHUB_PAT;
  if (!token) {
    throw new Error('Chưa cấu hình GITHUB_PAT trong Cloudflare Secrets!');
  }

  const owner = env.GITHUB_OWNER || 'luongtien06';
  const repo = env.GITHUB_REPO || 'Family_Luong';
  const url = endpoint.startsWith('https://') 
    ? endpoint 
    : `https://api.github.com/repos/${owner}/${repo}${endpoint}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Family-Luong-Worker-Backend/1.0',
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = handleCors(request, env);

    // Xử lý Preflight CORS OPTIONS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. Health check & Trang chủ
      if (path === '/' || path === '/api') {
        return jsonResponse({
          service: 'Family Luong Cloudflare Sync Worker',
          status: 'online',
          version: '1.0.0',
          repo: `${env.GITHUB_OWNER || 'luongtien06'}/${env.GITHUB_REPO || 'Family_Luong'}`,
          branch: env.GITHUB_BRANCH || 'main'
        }, 200, corsHeaders);
      }

      // 2. Xác thực quyền Admin (Verify Token)
      if (path === '/api/verify' && request.method === 'POST') {
        const auth = checkAdminAuth(request, env);
        if (!auth.ok) {
          return errorResponse(auth.message, auth.status, corsHeaders);
        }
        return jsonResponse({ valid: true, message: 'Xác thực quản trị viên thành công.' }, 200, corsHeaders);
      }

      // 3. Lấy trạng thái đồng bộ & triển khai GitHub Pages (Status)
      if (path === '/api/status' && request.method === 'GET') {
        const branch = env.GITHUB_BRANCH || 'main';
        try {
          // Lấy commit mới nhất
          const commitRes = await callGitHubApi(`/commits/${branch}`, env);
          let latestCommit = null;
          if (commitRes.ok) {
            const cData = await commitRes.json();
            latestCommit = {
              sha: cData.sha.substring(0, 7),
              fullSha: cData.sha,
              message: cData.commit?.message || '',
              date: cData.commit?.committer?.date || '',
              author: cData.commit?.committer?.name || ''
            };
          }

          // Lấy trạng thái GitHub Pages
          let pagesStatus = null;
          try {
            const pagesRes = await callGitHubApi('/pages/builds/latest', env);
            if (pagesRes.ok) {
              const pData = await pagesRes.json();
              pagesStatus = {
                status: pData.status, // 'built', 'building', 'errored'
                updatedAt: pData.updated_at
              };
            }
          } catch (e) {
            // Không bắt buộc nếu pages builds API không bật
          }

          return jsonResponse({
            success: true,
            latestCommit,
            pagesStatus,
            timestamp: new Date().toISOString()
          }, 200, corsHeaders);
        } catch (e) {
          return errorResponse('Không thể lấy thông tin từ GitHub: ' + e.message, 502, corsHeaders);
        }
      }

      // 4. API Tải lên ảnh đơn lẻ (Upload Photo Blob)
      if (path === '/api/upload-photo' && request.method === 'POST') {
        const auth = checkAdminAuth(request, env);
        if (!auth.ok) {
          return errorResponse(auth.message, auth.status, corsHeaders);
        }

        const body = await request.json().catch(() => null);
        if (!body || !body.fileName || !body.contentBase64) {
          return errorResponse('Thiếu tham số fileName hoặc contentBase64!', 400, corsHeaders);
        }

        const { fileName, contentBase64 } = body;

        // Kiểm tra tên tệp hợp lệ (chữ thường, số, gạch ngang, đuôi ảnh chuẩn)
        if (!/^[a-z0-9][a-z0-9-]*\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
          return errorResponse('Tên tệp ảnh không hợp lệ! Chỉ cho phép chữ thường không dấu, số, dấu gạch ngang và đuôi .jpg, .png, .webp.', 400, corsHeaders);
        }

        // Tách header base64 nếu có
        const cleanBase64 = contentBase64.includes(',') ? contentBase64.split(',')[1] : contentBase64;

        // Giới hạn dung lượng 5MB
        if (cleanBase64.length > 7 * 1024 * 1024) {
          return errorResponse('Dung lượng ảnh vượt quá giới hạn 5MB!', 413, corsHeaders);
        }

        // Kiểm tra magic bytes
        const magicCheck = validateImageMagicBytes(cleanBase64);
        if (!magicCheck.valid) {
          return errorResponse(magicCheck.error, 400, corsHeaders);
        }

        // Tạo Git Blob trên GitHub
        const blobRes = await callGitHubApi('/git/blobs', env, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: cleanBase64,
            encoding: 'base64'
          })
        });

        if (!blobRes.ok) {
          const errData = await blobRes.json().catch(() => ({}));
          return errorResponse(`Lỗi tạo blob GitHub: ${errData.message || blobRes.statusText}`, blobRes.status, corsHeaders);
        }

        const blobData = await blobRes.json();
        return jsonResponse({
          success: true,
          fileName,
          blobSha: blobData.sha
        }, 200, corsHeaders);
      }

      // 5. MASTER ATOMIC SYNC: Đồng bộ nguyên khối ảnh & data.json qua Git Data API
      if (path === '/api/sync' && request.method === 'POST') {
        const auth = checkAdminAuth(request, env);
        if (!auth.ok) {
          return errorResponse(auth.message, auth.status, corsHeaders);
        }

        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.members)) {
          return errorResponse('Dữ liệu không hợp lệ: thiếu danh sách members!', 400, corsHeaders);
        }

        const {
          members,
          nextId = (Math.max(...members.map(m => m.id || 0), 0) + 1),
          newPhotos = [], // Mảng các object { fileName, contentBase64 }
          deletedPhotos = [], // Mảng các tên tệp cần xóa
          commitMessage = 'Cập nhật cây gia phả và ảnh thành viên từ Admin'
        } = body;

        const branch = env.GITHUB_BRANCH || 'main';

        // BƯỚC 5.1: Lấy commit SHA hiện tại của nhánh
        const refRes = await callGitHubApi(`/git/ref/heads/${branch}`, env);
        if (!refRes.ok) {
          const err = await refRes.json().catch(() => ({}));
          return errorResponse(`Không tìm thấy nhánh ${branch}: ${err.message || refRes.statusText}`, 500, corsHeaders);
        }
        const refData = await refRes.json();
        const currentCommitSha = refData.object.sha;

        // BƯỚC 5.2: Lấy Tree SHA từ commit hiện tại
        const commitRes = await callGitHubApi(`/git/commits/${currentCommitSha}`, env);
        if (!commitRes.ok) {
          return errorResponse('Không đọc được commit hiện tại từ GitHub', 500, corsHeaders);
        }
        const commitData = await commitRes.json();
        const baseTreeSha = commitData.tree.sha;

        // BƯỚC 5.3: Tạo Git Blobs cho toàn bộ ảnh mới tải lên
        const treeEntries = [];
        const uploadedFileNames = [];

        for (const photo of newPhotos) {
          if (!photo.fileName || !photo.contentBase64) continue;

          const fileName = photo.fileName.trim();
          if (!/^[a-z0-9][a-z0-9-]*\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
            return errorResponse(`Tên tệp "${fileName}" không hợp lệ!`, 400, corsHeaders);
          }

          const cleanBase64 = photo.contentBase64.includes(',') 
            ? photo.contentBase64.split(',')[1] 
            : photo.contentBase64;

          const magicCheck = validateImageMagicBytes(cleanBase64);
          if (!magicCheck.valid) {
            return errorResponse(`Ảnh "${fileName}": ${magicCheck.error}`, 400, corsHeaders);
          }

          const blobRes = await callGitHubApi('/git/blobs', env, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: cleanBase64,
              encoding: 'base64'
            })
          });

          if (!blobRes.ok) {
            const err = await blobRes.json().catch(() => ({}));
            return errorResponse(`Lỗi upload ảnh "${fileName}": ${err.message || blobRes.statusText}`, 500, corsHeaders);
          }

          const blobData = await blobRes.json();
          treeEntries.push({
            path: `assets/members/${fileName}`,
            mode: '100644',
            type: 'blob',
            sha: blobData.sha
          });
          uploadedFileNames.push(fileName);
        }

        // BƯỚC 5.4: Kiểm tra và đánh dấu xóa các tệp ảnh không còn thành viên nào sử dụng
        const actuallyDeletedFiles = [];
        for (const delFileName of deletedPhotos) {
          if (!delFileName || typeof delFileName !== 'string') continue;
          const cleanName = delFileName.trim();

          // Kiểm tra xem có bất kỳ thành viên nào hoặc vợ/chồng nào vẫn đang tham chiếu không
          const isStillReferenced = members.some(m => 
            m.photo === cleanName || m.Image === cleanName || m.spousePhoto === cleanName
          );

          if (!isStillReferenced) {
            // Trong Git Data API, để xóa một tệp trong cây, ta gán sha: null
            treeEntries.push({
              path: `assets/members/${cleanName}`,
              mode: '100644',
              type: 'blob',
              sha: null
            });
            actuallyDeletedFiles.push(cleanName);
          }
        }

        // BƯỚC 5.5: Tạo Git Blob cho tệp data.json mới
        const dataJsonContent = JSON.stringify({ members, nextId }, null, 2);
        const dataBlobRes = await callGitHubApi('/git/blobs', env, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: dataJsonContent,
            encoding: 'utf-8'
          })
        });

        if (!dataBlobRes.ok) {
          const err = await dataBlobRes.json().catch(() => ({}));
          return errorResponse(`Lỗi tạo blob data.json: ${err.message || dataBlobRes.statusText}`, 500, corsHeaders);
        }

        const dataBlobData = await dataBlobRes.json();
        treeEntries.push({
          path: 'data.json',
          mode: '100644',
          type: 'blob',
          sha: dataBlobData.sha
        });

        // BƯỚC 5.6: Tạo Git Tree mới kế thừa từ baseTreeSha
        const newTreeRes = await callGitHubApi('/git/trees', env, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: treeEntries
          })
        });

        if (!newTreeRes.ok) {
          const err = await newTreeRes.json().catch(() => ({}));
          return errorResponse(`Lỗi tạo Git Tree: ${err.message || newTreeRes.statusText}`, 500, corsHeaders);
        }

        const newTreeData = await newTreeRes.json();
        const newTreeSha = newTreeData.sha;

        // BƯỚC 5.7: Tạo Git Commit mới
        const newCommitRes = await callGitHubApi('/git/commits', env, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: commitMessage,
            tree: newTreeSha,
            parents: [currentCommitSha]
          })
        });

        if (!newCommitRes.ok) {
          const err = await newCommitRes.json().catch(() => ({}));
          return errorResponse(`Lỗi tạo Git Commit: ${err.message || newCommitRes.statusText}`, 500, corsHeaders);
        }

        const newCommitData = await newCommitRes.json();
        const newCommitSha = newCommitData.sha;

        // BƯỚC 5.8: Cập nhật Branch Ref (main) trỏ tới commit mới với force: false (chống xung đột)
        const updateRefRes = await callGitHubApi(`/git/refs/heads/${branch}`, env, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sha: newCommitSha,
            force: false
          })
        });

        if (!updateRefRes.ok) {
          if (updateRefRes.status === 409 || updateRefRes.status === 422) {
            return errorResponse(
              'Xung đột cập nhật: Repository đã có commit mới hơn từ người khác trong lúc thao tác! Vui lòng tải lại trang và thực hiện lại.',
              409,
              corsHeaders
            );
          }
          const err = await updateRefRes.json().catch(() => ({}));
          return errorResponse(`Lỗi cập nhật nhánh ${branch}: ${err.message || updateRefRes.statusText}`, 500, corsHeaders);
        }

        // BƯỚC 5.9: Trả về kết quả thành công nguyên khối
        return jsonResponse({
          success: true,
          commitSha: newCommitSha.substring(0, 7),
          fullCommitSha: newCommitSha,
          treeSha: newTreeSha,
          uploadedPhotos: uploadedFileNames,
          deletedPhotos: actuallyDeletedFiles,
          totalMembers: members.length,
          message: 'Đã commit nguyên khối thành công cả dữ liệu và ảnh lên GitHub Repository!',
          timestamp: new Date().toISOString()
        }, 200, corsHeaders);
      }

      // Endpoint không tồn tại
      return errorResponse(`Endpoint "${path}" không tồn tại!`, 404, corsHeaders);

    } catch (err) {
      return errorResponse('Lỗi máy chủ nội bộ: ' + (err.message || String(err)), 500, corsHeaders);
    }
  }
};
